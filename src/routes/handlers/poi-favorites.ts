/**
 * GET  /api/poi-favorites            — 列出當前使用者的 POI 收藏（JOIN pois + usages）
 * POST /api/poi-favorites { poiId, note?, companionRequestId? } — 新增收藏
 *
 * Companion path: see functions/api/_companion.ts (requireFavoriteActor +
 * pickFavoriteBucketForActor). 所有寫入皆限流（Phase 3：無 admin 豁免）。
 *
 * v2.33.105 SEC-2: pre-gate per-IP throttle 在 actor resolve 之前；post-gate
 * bucket 用 resolved actor 而非 claimed body 防 bucket-spoof DoS。
 */
import { AppError } from '../../errors';
import { buildRateLimitResponse } from '../../errors';
import { logAudit } from '../../lib/audit';
import { json, parseJsonBody } from '../../lib/utils';
import { bumpRateLimit, RATE_LIMITS } from '../../lib/rate-limit';
import { assertNotTripRestricted } from '../../lib/permissions';
import {
  pickFavoriteBucketForActor,
  preGateFavoriteThrottle,
  requireFavoriteActor,
} from '../../lib/companion';
import type { Env, AuthData } from '../../env';

interface PoiFavoritePostBody {
  poiId?: number;
  note?: string;
  companionRequestId?: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = (context.data as { auth?: AuthData }).auth ?? null;
  // restrict_trip token 不可碰跨 trip 的 user 收藏（favorites 是 user-scoped，非單 trip）
  // — security-auditor HIGH：v2.55.56 downscoped token 的 user_id=owner，此 user-path
  //   會列舉 owner 全跨 trip 收藏。containment。
  if (auth) assertNotTripRestricted(auth);

  // poi-favorites-rename §7：companion 模式從 ?companionRequestId=N query string 取
  // requestId、走 requireFavoriteActor 三 gate；gate 失敗 → 401。
  // 非 companion header 維持既有行為：anonymous / service-token without userId → []
  let effectiveUserId: string;
  const headerScope = context.request.headers.get('X-Request-Scope');
  if (headerScope === 'companion') {
    // v2.33.105 SEC-2: pre-gate per-IP throttle 防 actor resolve DB hammering
    const preGate = await preGateFavoriteThrottle(context.env, context.request);
    if (preGate) return preGate;
    const actor = await requireFavoriteActor(context, null, 'favorite_list');
    effectiveUserId = actor.userId;
  } else if (auth?.userId) {
    effectiveUserId = auth.userId;
  } else {
    return json([]); // anonymous / service-token without resolution → empty
  }

  const { results } = await context.env.DB.prepare(
    // v2.31.17: 補 p.rating 進 SELECT，讓 AddStopPage / ChangePoiPage favorites
    // card 可以顯 ★ N.N（之前是孤兒 star icon 拔掉，現在 backend 有 data 可補回）。
    `SELECT pf.id, pf.user_id, pf.poi_id, pf.favorited_at, pf.note,
            p.name AS poi_name, p.address AS poi_address,
            p.lat AS poi_lat, p.lng AS poi_lng, p.type AS poi_type,
            p.rating AS poi_rating,
            COALESCE(
              (SELECT json_group_array(json_object(
                  'tripId', usage.trip_id,
                  'tripName', usage.trip_name,
                  'dayNum', usage.day_num,
                  'dayDate', usage.day_date,
                  'entryId', usage.entry_id
                ))
                FROM (
                  SELECT t.id AS trip_id, t.name AS trip_name, td.day_num, td.date AS day_date, e.id AS entry_id
                  FROM trip_entry_pois tep
                  JOIN trip_entries e ON e.id = tep.entry_id
                  JOIN trip_days td ON td.id = e.day_id
                  JOIN trips t ON t.id = td.trip_id
                  WHERE tep.poi_id = pf.poi_id
                    AND (
                      t.owner_user_id = ?1
                      OR EXISTS (
                        SELECT 1 FROM trip_permissions perm
                        WHERE perm.trip_id = t.id AND perm.user_id = ?1
                      )
                    )
                  UNION
                  -- v2.29.0: trip_pois DROPPED. Hotel usage 從 trip_days.hotel_poi_id 取。
                  SELECT t.id AS trip_id, t.name AS trip_name, td.day_num, td.date AS day_date, NULL AS entry_id
                  FROM trip_days td
                  JOIN trips t ON t.id = td.trip_id
                  WHERE td.hotel_poi_id = pf.poi_id
                    AND (
                      t.owner_user_id = ?1
                      OR EXISTS (
                        SELECT 1 FROM trip_permissions perm
                        WHERE perm.trip_id = t.id AND perm.user_id = ?1
                      )
                    )
                ) usage
              ),
              '[]'
            ) AS usages_json
     FROM poi_favorites pf
     JOIN pois p ON p.id = pf.poi_id
     WHERE pf.user_id = ?1 AND pf.deleted_at IS NULL
     ORDER BY pf.favorited_at DESC, pf.id DESC`,
  ).bind(effectiveUserId).all();

  const enriched = (results ?? []).map((r) => {
    const { usages_json, ...rest } = r as Record<string, unknown> & { usages_json?: string };
    return { ...rest, usages: usages_json ? JSON.parse(usages_json) : [] };
  });

  return json(enriched);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // restrict_trip token 不可寫跨 trip 的 user 收藏（favorites user-scoped）— containment。
  const auth = (context.data as { auth?: AuthData }).auth ?? null;
  if (auth) assertNotTripRestricted(auth);

  // v2.33.105 SEC-2: pre-gate per-IP throttle 在 actor resolve 之前。寬鬆
  // 200/5min/IP，正常 user 不會打中；攻擊者 hammer 才會觸 lock。
  const preGate = await preGateFavoriteThrottle(context.env, context.request);
  if (preGate) return preGate;

  // 解析 body。malformed body 直接 400。
  const body = await parseJsonBody<PoiFavoritePostBody>(context.request);

  // 先驗 poiId 早 reject 不浪費 actor resolve（companion 與 V2 user 共用）
  if (!body.poiId || !Number.isInteger(body.poiId) || body.poiId <= 0) {
    throw new AppError('DATA_VALIDATION', '缺少或無效的 poiId');
  }

  // 真正解 effective userId。companion gate 失敗 → V2 user fallback；
  // V2 user fallback userId null → 拋 401。
  // 同時為 companion 模式寫 companion_request_actions（UNIQUE 衝突 → 409 COMPANION_QUOTA_EXCEEDED）。
  const actor = await requireFavoriteActor(context, body, 'favorite_create');

  // v2.33.105 SEC-2: post-gate bucket 用 RESOLVED actor，而非 claimed body。
  // Phase 3（移除全域 admin）：無 admin rate-limit 豁免，所有寫入皆限流。
  const bucket = pickFavoriteBucketForActor(actor, 'poi-favorites-post');
  const bump = await bumpRateLimit(context.env.DB, bucket, RATE_LIMITS.POI_FAVORITES_WRITE);
  if (!bump.ok) return buildRateLimitResponse(bump.retryAfter ?? 60, { error: 'RATE_LIMITED' });

  // 建立收藏（spec §4 soft-delete 相容）：先重新啟用既有 soft-deleted row（保留原 id）、
  // 沒有才 INSERT 新 row。partial unique index（idx_poi_favorites_active_user_poi，只限
  // deleted_at IS NULL）保證同 (user,poi) 至多 1 筆 active：
  //   - 已有 active → reactivate/INSERT 皆撞 partial unique → 409（已收藏、不 500）
  //   - 只有 soft-deleted → reactivate → 201（新的一次收藏，套新 note/favorited_at、不受 10 分鐘 undo 限制）
  //   - 都沒有 → INSERT → 201
  // 競速（restore vs 重新 POST）由 partial unique index 兜底：第二筆 → UNIQUE 違反 → 409，最後恆 1 筆 active。
  let row: Record<string, unknown> | null = null;
  try {
    row = await context.env.DB
      .prepare(
        `UPDATE poi_favorites
            SET deleted_at = NULL, note = ?3, favorited_at = datetime('now')
          WHERE id = (
            SELECT id FROM poi_favorites
             WHERE user_id = ?1 AND poi_id = ?2 AND deleted_at IS NOT NULL
             ORDER BY favorited_at DESC, id DESC LIMIT 1
          )
          RETURNING *`,
      )
      .bind(actor.userId, body.poiId, body.note ?? null)
      .first<Record<string, unknown>>();
    if (!row) {
      // 無 soft-deleted 可重用 → 新增。FK 失敗（POI 不存在）轉 404；partial UNIQUE 違反（已有 active）→ 409。
      row = await context.env.DB
        .prepare(
          `INSERT INTO poi_favorites (user_id, poi_id, note) VALUES (?, ?, ?) RETURNING *`,
        )
        .bind(actor.userId, body.poiId, body.note ?? null)
        .first<Record<string, unknown>>();
    }
    if (!row) throw new AppError('SYS_INTERNAL', 'INSERT RETURNING 未回傳資料');
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error) {
      if (err.message.includes('UNIQUE')) throw new AppError('DATA_CONFLICT', '該 POI 已收藏');
      if (err.message.includes('FOREIGN KEY')) throw new AppError('DATA_NOT_FOUND', 'POI 不存在');
    }
    throw err;
  }

  // companion 模式寫 audit_log（D5 sentinel）— fire-and-forget 不阻塞 response
  if (actor.isCompanion) {
    context.waitUntil(
      logAudit(context.env.DB, {
        tripId: actor.audit.tripId,
        tableName: 'poi_favorites',
        recordId: row.id as number,
        action: 'insert',
        changedBy: actor.audit.changedBy,
        requestId: actor.requestId,
      }),
    );
  }

  return json(row, 201);
};
