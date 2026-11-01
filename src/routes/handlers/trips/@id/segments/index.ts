/**
 * GET /api/trips/:id/segments
 *
 * 回傳該行程所有 trip_segments（兩 entry 之間的交通段）。
 * 前端 TimelineRail / TravelPill 用此 list 配對 entry，自行 join entry context。
 *
 * v2.24.0 起 segments 是 travel data 的 source of truth；v2.29.0 entry.travel_*
 * 已 DROPPED。v2.30.0 mode_source 已 DROPPED — transit 自然代理 user override。
 *
 * Auth: trip read permission.
 */

import { requireAuth, requireTripReadAccess, requireTripWrite } from '../../../../../lib/permissions';
import { AppError } from '../../../../../errors';
import { json, getAuth, parseJsonBody } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';
import { isSegmentMode, isValidMin, resolveSegmentTravel, sanitizeSubmode, SEGMENT_RETURNING_COLS } from './_shared';

interface SegmentRow {
  id: number;
  trip_id: string;
  from_entry_id: number;
  to_entry_id: number;
  mode: string;
  submode: string | null;
  min: number | null;
  distance_m: number | null;
  source: string | null;
  computed_at: number | null;
  updated_at: number | null;
  version: number;
  /** v2.55.46: 1 = 同一地點/免交通（收合此段）；NULL = 正常交通段。 */
  no_travel: number | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const tripId = context.params.id as string;
  if (!tripId) throw new AppError('DATA_VALIDATION', '缺少 tripId');

  const db = context.env.DB;
  // v2.33.41 security: gate anonymous read — published trips allow,
  // otherwise owner/member only (取代之前 requireAuth + hasPermission，
  // 對齊其他 trips/[id]/* GET handler 的 published-aware 模型)。
  await requireTripReadAccess(db, getAuth(context), tripId);

  const res = await db
    .prepare(
      `SELECT s.id, s.trip_id, s.from_entry_id, s.to_entry_id,
              s.mode, s.submode, s.min, s.distance_m, s.source,
              s.computed_at, s.updated_at, s.version, s.no_travel
       FROM trip_segments s
       JOIN trip_entries fe ON fe.id = s.from_entry_id
       JOIN trip_days fd ON fd.id = fe.day_id
       WHERE s.trip_id = ?
       ORDER BY fd.day_num ASC, fe.sort_order ASC`,
    )
    .bind(tripId)
    .all<SegmentRow>();

  return json(res.results ?? []);
};

interface CreateSegmentBody {
  from_entry_id?: number;
  to_entry_id?: number;
  mode?: string;
  min?: number;
  /** v2.55.45: 交通方式細分（monorail/bus/metro/train/hsr/自由文字）；只在 transit 有意義。 */
  submode?: string | null;
  /** v2.55.46: true = 建立「同一地點/免交通」段（繞過 mode/min）。 */
  noTravel?: boolean;
}

/**
 * POST /api/trips/:id/segments
 *
 * 建立（或 upsert）一段 from→to entry 的 travel segment。當 recompute 尚未跑、segment
 * 不存在時，讓 user 從 EditEntryPage 手動設移動方式（開車 / 步行 / 大眾運輸）。
 *
 * Body：{ from_entry_id, to_entry_id, mode, min? }
 *   - driving / walking → 一律打 Google Routes 重算（ignore body.min）；缺 coords / API
 *     失敗 → INSERT min/distance=NULL（stale，computed_at=NULL）。
 *   - transit → 必填 min（1–1440），source='manual'。
 *
 * trip_segments 有 UNIQUE(from_entry_id, to_entry_id) → INSERT ON CONFLICT DO UPDATE
 * （同 pair 重送 = 改 mode，等同 PATCH /:sid）。Auth: trip write permission.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const tripId = context.params.id as string;
  if (!tripId) throw new AppError('DATA_VALIDATION', '缺少 tripId');

  const db = context.env.DB;
  await requireTripWrite(db, auth, tripId);

  const body = await parseJsonBody<CreateSegmentBody>(context.request);

  const fromEntryId = body.from_entry_id;
  const toEntryId = body.to_entry_id;
  if (
    typeof fromEntryId !== 'number' || !Number.isInteger(fromEntryId) || fromEntryId <= 0 ||
    typeof toEntryId !== 'number' || !Number.isInteger(toEntryId) || toEntryId <= 0
  ) {
    throw new AppError('DATA_VALIDATION', 'from_entry_id / to_entry_id 須為正整數');
  }
  if (fromEntryId === toEntryId) {
    throw new AppError('DATA_VALIDATION', 'from / to entry 不可相同');
  }

  const isNoTravel = body.noTravel === true;

  // 防 IDOR：兩個 entry 都必須屬於該 trip
  const owned = await db
    .prepare(
      `SELECT te.id
       FROM trip_entries te
       JOIN trip_days td ON td.id = te.day_id
       WHERE td.trip_id = ? AND te.id IN (?, ?)`,
    )
    .bind(tripId, fromEntryId, toEntryId)
    .all<{ id: number }>();
  if ((owned.results ?? []).length !== 2) {
    throw new AppError('DATA_NOT_FOUND', 'from / to entry 不屬於此行程');
  }

  const now = Date.now();

  // v2.55.46: 同一地點/免交通 — 建立收合段。no_travel=1 自足當 recompute skip 訊號（source 不設
  // 'manual'，不 overload 其「手動鎖定值」語意；min/dist/source=NULL）。noTravel 不需 mode/min，故
  // early-return 在方式驗證之前。既有 pair 重送 → DO UPDATE 標記（保留現有 mode/submode，不強制 'walking'）。
  if (isNoTravel) {
    const created = await db
      .prepare(
        `INSERT INTO trip_segments
           (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at, no_travel)
         VALUES (?, ?, ?, 'walking', NULL, NULL, NULL, NULL, ?, ?, 1)
         ON CONFLICT (from_entry_id, to_entry_id) DO UPDATE SET
           no_travel = 1, min = NULL, distance_m = NULL, source = NULL,
           computed_at = excluded.computed_at, updated_at = excluded.updated_at,
           version = trip_segments.version + 1
         RETURNING ${SEGMENT_RETURNING_COLS}`,
      )
      .bind(tripId, fromEntryId, toEntryId, now, now)
      .first();
    if (!created) throw new AppError('DATA_SAVE_FAILED', '建立 segment 失敗');
    return json(created, 201);
  }

  // 正常交通段：noTravel 已 early-return，此後驗證無 noTravel 意識。
  if (!isSegmentMode(body.mode)) {
    throw new AppError('DATA_VALIDATION', 'mode 必須為 driving / walking / transit');
  }
  const mode = body.mode;
  const submode = sanitizeSubmode(body.submode, mode);

  // v2.55.45: min 有帶就必須合法；不帶 = 自動算。純手填方式缺 min 由 resolveSegmentTravel throw。
  if (body.min !== undefined && !isValidMin(body.min)) {
    throw new AppError('DATA_VALIDATION', 'min 須為 1–1440 分鐘');
  }

  const travel = await resolveSegmentTravel(context.env, db, fromEntryId, toEntryId, mode, submode, body.min, now);

  const min = travel.ok ? travel.min : null;
  const distanceM = travel.ok ? travel.distanceM : null;
  const source = travel.ok ? travel.source : null;
  const computedAt = travel.ok ? travel.computedAt : null;
  const subToStore = travel.ok ? travel.submode : submode;

  // INSERT ON CONFLICT(from_entry_id, to_entry_id) → upsert（同 pair 重設 mode），RETURNING
  // 一次回 row（省 SELECT-back round-trip）。
  // 注意：不同於 recompute-travel 的 upsert 帶 `WHERE mode != 'transit'` guard（自動重算
  // 不覆蓋 user 手填的 transit），POST 是 user 主動設 mode → 覆蓋既有 transit 是 user 意圖，
  // 故無 guard。
  const created = await db
    .prepare(
      `INSERT INTO trip_segments
         (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (from_entry_id, to_entry_id) DO UPDATE SET
         mode = excluded.mode,
         submode = excluded.submode,
         min = excluded.min,
         distance_m = excluded.distance_m,
         source = excluded.source,
         computed_at = excluded.computed_at,
         updated_at = excluded.updated_at,
         no_travel = NULL,
         version = trip_segments.version + 1
       RETURNING ${SEGMENT_RETURNING_COLS}`,
    )
    .bind(tripId, fromEntryId, toEntryId, mode, subToStore, min, distanceM, source, computedAt, now)
    .first();
  if (!created) throw new AppError('DATA_SAVE_FAILED', '建立 segment 失敗');
  return json(created, 201);
};
