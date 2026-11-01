/**
 * POST /api/poi-favorites/:id/add-to-trip — 從「收藏」加入指定 trip 的 fast-path。
 *
 * Body（poi-favorites-rename §9 + design D14 — 4-field 純時間驅動）：
 *   { tripId, dayNum, startTime, endTime, companionRequestId? }
 *
 * 廢除欄位：position / anchorEntryId（送上 → 400「欄位已廢除」）。
 *
 * Server 依 startTime 自動計算 sort_order（找該 day 中所有 entries，將新 entry 排在
 * startTime 之後第一個 entry 之前；若沒有更晚 entry 則 append 到末尾）。
 * Conflict detection 邏輯保留：newStart < eEnd AND newEnd > eStart → 409 + conflictWith。
 *
 * Auth（Phase 3：無全域 admin bypass）：
 *   - V2 user：必須是 favorite owner + 對 tripId 有 hasWritePermission
 *   - companion：requireFavoriteActor(action='add_to_trip')；ownership 用 resolved
 *     userId（submitter）比 favorite.user_id。
 *
 * v2.29.0: travel_* DROPPED, trip_segments 由 /recompute-travel 在背景 fill。
 */
import { assertNotTripRestricted, hasWritePermission } from '../../../../lib/permissions';
import { createEntry } from '../../../../lib/entry-write';
import { AppError, buildRateLimitResponse } from '../../../../errors';
import { detectGarbledText } from '../../../../lib/validate';
import { json, parseIntParam, parseJsonBody } from '../../../../lib/utils';
// v2.26.0: TIME_RE canonical 在 _time.ts（migration 0056 後 entry-time helpers 統一住處）。
import { TIME_RE } from '../../../../lib/time';
import {
  assertFavoriteOwnership,
  pickFavoriteBucketForActor,
  preGateFavoriteThrottle,
  requireFavoriteActor,
} from '../../../../lib/companion';
import { bumpRateLimit, RATE_LIMITS } from '../../../../lib/rate-limit';
import type { Env, AuthData } from '../../../../env';

interface Body {
  tripId?: string;
  dayNum?: number;
  startTime?: string;
  endTime?: string;
  companionRequestId?: number;
  // 廢除欄位，存在即 reject
  position?: unknown;
  anchorEntryId?: unknown;
}

/** "HH:MM" → minutes since midnight. */
function hhmmToMin(t: string): number {
  const [h, m] = t.split(':');
  return parseInt(h!, 10) * 60 + parseInt(m!, 10);
}

export const onRequestPost: PagesFunction<Env, 'id'> = async (context) => {
  const auth = (context.data as { auth?: AuthData }).auth ?? null;
  // restrict_trip token 不可經收藏 fast-path 把 owner 跨 trip 收藏（含私人 note）加進 trip
  // — hasWritePermission 只擋跨 trip 寫、不擋讀 owner 收藏。containment（security-auditor HIGH）。
  if (auth) assertNotTripRestricted(auth);
  const favoriteId = parseIntParam(context.params.id as string);
  if (!favoriteId) throw new AppError('DATA_VALIDATION', 'favoriteId 須為正整數');

  // v2.33.105 SEC-2: pre-gate per-IP throttle 在 actor resolve / DB work 之前
  const preGate = await preGateFavoriteThrottle(context.env, context.request);
  if (preGate) return preGate;

  const body = await parseJsonBody<Body>(context.request);

  // 廢除欄位 reject — 防止 client/skill 送 stale schema（design D14）
  if (body.position !== undefined || body.anchorEntryId !== undefined) {
    throw new AppError(
      'DATA_VALIDATION',
      'position / anchorEntryId 欄位已廢除（4-field 純時間驅動）：請改用 startTime + endTime',
    );
  }

  const { tripId, dayNum, startTime, endTime } = body;
  if (!tripId) throw new AppError('DATA_VALIDATION', '缺少 tripId');
  if (!Number.isInteger(dayNum) || (dayNum as number) < 1) {
    throw new AppError('DATA_VALIDATION', 'dayNum 須為 ≥1 的整數');
  }
  if (!startTime || !TIME_RE.test(startTime)) {
    throw new AppError('DATA_VALIDATION', 'startTime 必填，須為 HH:MM 格式');
  }
  if (!endTime || !TIME_RE.test(endTime)) {
    throw new AppError('DATA_VALIDATION', 'endTime 必填，須為 HH:MM 格式');
  }

  // Resolve effective actor（V2 user 或 companion submitter；gate 失敗 → 401）
  const actor = await requireFavoriteActor(context, body, 'add_to_trip');

  // v2.33.105 SEC-2: post-gate bucket — 用 RESOLVED actor，bucket key 與 POST
  // /api/poi-favorites 區隔（自己一池），避免互相吃 quota。
  // Phase 3（移除全域 admin）：無 admin rate-limit 豁免。
  const rlBucket = pickFavoriteBucketForActor(actor, 'poi-favorites-add-to-trip');
  const bump = await bumpRateLimit(context.env.DB, rlBucket, RATE_LIMITS.POI_FAVORITES_WRITE);
  if (!bump.ok) return buildRateLimitResponse(bump.retryAfter ?? 60, { error: 'RATE_LIMITED' });

  const db = context.env.DB;

  // Parallel reads：favorite + write permission + day existence
  const [favorite, hasWrite, day] = await Promise.all([
    db
      .prepare(
        `SELECT pf.id, pf.user_id, pf.poi_id, pf.note,
                p.name AS poi_name, p.type AS poi_type
         FROM poi_favorites pf
         JOIN pois p ON p.id = pf.poi_id
         WHERE pf.id = ? AND pf.deleted_at IS NULL`,
      )
      .bind(favoriteId)
      .first<{
        id: number;
        user_id: string | null;
        poi_id: number;
        note: string | null;
        poi_name: string;
        poi_type: string;
      }>(),
    actor.isCompanion
      ? // companion 模式：用 submitter (actor.userId) 對 body.tripId 檢查 write 權限。
        // 防止 prompt-injected message 將 POI 加進 submitter 沒權限的 trip
        // （CSO audit finding：原 short-circuit `Promise.resolve(true)` 跳過 tripId guard）。
        db
          .prepare("SELECT 1 FROM trip_permissions WHERE user_id = ? AND trip_id = ? AND role != 'viewer'")
          .bind(actor.userId, tripId)
          .first()
          .then((row) => !!row)
      : hasWritePermission(db, auth!, tripId),
    db
      .prepare('SELECT id FROM trip_days WHERE trip_id = ? AND day_num = ?')
      .bind(tripId, dayNum)
      .first<{ id: number }>(),
  ]);

  if (!favorite) throw new AppError('DATA_NOT_FOUND', '找不到該收藏');

  assertFavoriteOwnership(actor, favorite.user_id, '只能加入自己的收藏');
  if (!hasWrite) throw new AppError('PERM_DENIED');
  if (!day) throw new AppError('DATA_NOT_FOUND', `Day ${dayNum} 不存在`);

  // 收藏 note 含亂碼 → 阻擋（避免污染 trip_entries）
  if (favorite.note && detectGarbledText(favorite.note)) {
    throw new AppError('DATA_ENCODING', '收藏 note 包含疑似亂碼，請先到「我的收藏」修正');
  }

  // Conflict detection + sort_order 計算（一次查 day 的所有 entries）
  // v2.29.0: trip_entries.time DROPPED, 只看 start_time/end_time。
  // start_time 有但 end_time NULL → 視為瞬間點（end = start）。
  const newStartMin = hhmmToMin(startTime);
  const newEndMin = hhmmToMin(endTime);
  const { results: dayEntries } = await db
    .prepare(`
      SELECT e.id, e.start_time, e.end_time, e.sort_order, p.name AS display_title
      FROM trip_entries e
      LEFT JOIN trip_entry_pois tep ON tep.entry_id = e.id AND tep.sort_order = 1
      LEFT JOIN pois p ON p.id = tep.poi_id
      WHERE e.day_id = ?
      ORDER BY e.sort_order ASC
    `)
    .bind(day.id)
    .all<{
      id: number;
      start_time: string | null;
      end_time: string | null;
      sort_order: number;
      display_title: string | null;
    }>();

  /** 取得 entry 的 [startMin, endMin]：純看 start_time/end_time。 */
  function entryRange(entry: { start_time: string | null; end_time: string | null }): [number, number] | null {
    if (!entry.start_time) return null;
    const start = hhmmToMin(entry.start_time);
    if (!Number.isFinite(start)) return null;
    const end = entry.end_time ? hhmmToMin(entry.end_time) : start; // single-time = 瞬間點
    return [start, Number.isFinite(end) ? end : start];
  }

  for (const entry of dayEntries ?? []) {
    const range = entryRange(entry);
    if (!range) continue;
    const [eStart, eEnd] = range;
    if (newStartMin < eEnd && newEndMin > eStart) {
      return json({
        error: 'CONFLICT',
        conflictWith: {
          entryId: entry.id,
          time: entry.start_time && entry.end_time
            ? `${entry.start_time}-${entry.end_time}`
            : (entry.start_time ?? null),
          title: entry.display_title ?? '（未選擇景點）',
          dayNum,
        },
      }, 409);
    }
  }

  // sort_order auto-calc：找 startTime 之後第一個 entry，將新 entry 排在它之前；
  // 若沒有更晚 entry → append 到末尾（MAX(sort_order)+1，避免 gapped sequence 漏 shift）。
  // 已有 entry 但時間範圍無法 parse 視為早於。
  let insertSortOrder: number | null = null; // null = append sentinel
  for (const entry of dayEntries ?? []) {
    const range = entryRange(entry);
    if (!range) continue;
    const [eStart] = range;
    if (eStart > newStartMin) {
      insertSortOrder = entry.sort_order;
      break;
    }
  }
  // #1257 entry intake：讓位、INSERT、正選（含收藏 note）、version、resort、audit 全在 createEntry。
  const auditDiff: Record<string, unknown> = {
    via: 'poi-favorites-fast-path',
    favoriteId,
    poiId: favorite.poi_id,
    dayNum,
    startTime,
    endTime,
  };
  if (actor.isCompanion) auditDiff.companionTripId = tripId;
  const { entryId: newEntryId, row } = await createEntry(db, {
    dayId: day.id,
    poi: { id: favorite.poi_id },
    startTime,
    endTime,
    note: favorite.note ?? null,
    source: 'fast-path',
    placement: insertSortOrder === null ? undefined : { sortOrder: insertSortOrder, shift: true },
    audit: {
      tripId: actor.isCompanion ? actor.audit.tripId : tripId,
      changedBy: actor.isCompanion ? actor.audit.changedBy : (auth?.email ?? ''),
      requestId: actor.requestId,
      diff: auditDiff,
      defer: (p) => context.waitUntil(p),
    },
  });
  const finalSortOrder = row.sort_order as number;

  return json({
    ok: true,
    entryId: newEntryId,
    dayId: day.id,
    sortOrder: finalSortOrder,
    startTime,
    endTime,
    note: 'trip_segments 將由背景 /recompute-travel 計算填入',
  }, 201);
};
