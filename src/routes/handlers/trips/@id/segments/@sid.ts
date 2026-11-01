/**
 * PATCH /api/trips/:id/segments/:sid
 *
 * Set the travel mode for an existing segment.
 *
 * Body：
 *   { mode: 'driving' | 'walking' | 'transit', min?: number }
 *
 * v2.30.0 (mode_source DROPPED) 語意（算邏輯抽到 segments/_shared.ts，與 POST /segments 共用）：
 *   - mode='transit' → 必填 min（Japan Routes API 無 transit 資料），save as source='manual'，
 *     不打 Google API。切回 driving/walking 時會被 backend 重算覆蓋。
 *   - mode='driving' / 'walking' → **一律忽略 body.min**，強制走 Google Routes 從 from/to entry
 *     座標重算。source='google'。若 Routes 失敗 / 缺 coords → 保留舊 min + distance_m（不阻擋
 *     切換），computed_at=NULL 標 stale。
 *
 * 建立新 segment（recompute 未跑、segment 不存在）走 POST /api/trips/:id/segments。
 *
 * Auth: trip write permission.
 */

import { requireAuth, requireTripWrite } from '../../../../../lib/permissions';
import { AppError } from '../../../../../errors';
import { json, parseJsonBody, parseIntParam } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';
import { isSegmentMode, isValidMin, resolveSegmentTravel, sanitizeSubmode, SEGMENT_RETURNING_COLS } from './_shared';

interface PatchBody {
  mode?: string;
  min?: number;
  /** v2.55.45: 交通方式細分（monorail/bus/metro/train/hsr/自由文字）；只在 transit 有意義。 */
  submode?: string | null;
  /** v2.55.46: true = 標記「同一地點/免交通」（繞過 mode/min，收合此段）。 */
  noTravel?: boolean;
  /** v2.33.108: OCC token — autosave 帶；不符回 409 STALE_ENTRY。omit → backward compat。 */
  expectedVersion?: number;
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const tripId = context.params.id as string;
  const sidStr = context.params.sid as string;
  const sid = parseIntParam(sidStr);
  if (!tripId || sid === null) {
    throw new AppError('DATA_VALIDATION', '缺少 tripId / sid');
  }

  const db = context.env.DB;
  await requireTripWrite(db, auth, tripId);

  // 驗 segment 屬於該 trip（防 IDOR）+ 取 from/to entry + submode（PATCH 保留用）+ version for OCC
  const seg = await db
    .prepare('SELECT id, trip_id, from_entry_id, to_entry_id, submode, version FROM trip_segments WHERE id = ?')
    .bind(sid)
    .first<{ id: number; trip_id: string; from_entry_id: number; to_entry_id: number; submode: string | null; version: number }>();
  if (!seg || seg.trip_id !== tripId) {
    throw new AppError('DATA_NOT_FOUND', '找不到此 segment');
  }

  const body = await parseJsonBody<PatchBody>(context.request);

  // v2.33.108: OCC token check（pre-SELECT — segments 多 UPDATE 分支不適合
  // atomic CAS WHERE。frequency 低，TOCTOU race window 接受）。
  if (typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)) {
    if (seg.version !== body.expectedVersion) {
      throw new AppError('STALE_ENTRY', `expected version ${body.expectedVersion}, current ${seg.version}`);
    }
  }

  // v2.55.46: 同一地點/免交通 — 使用者把一段連續同地停靠標記為「無交通」（如同一機場內兩
  // 停靠點：那覇機場 → 牛排屋88 機場店）。繞過 resolveSegmentTravel（無需 mode/min）：
  //   no_travel=1（recompute 的 skip 訊號、read path 的 sameplace 訊號）、min/dist/source=NULL、
  //   computed_at=now（防前端 stale chip）。保留現有 mode/submode（mode 有 NOT NULL CHECK，不動）。
  //   注意：source 不設 'manual' — no_travel=1 自足當 skip 訊號，不 overload source 的「手動鎖定值」語意。
  if (body.noTravel === true) {
    const now = Date.now();
    const marked = await db
      .prepare(
        `UPDATE trip_segments
         SET no_travel = 1, min = NULL, distance_m = NULL, source = NULL,
             computed_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? RETURNING ${SEGMENT_RETURNING_COLS}`,
      )
      .bind(now, now, sid)
      .first();
    if (!marked) throw new AppError('DATA_NOT_FOUND', 'segment 已不存在');
    return json(marked);
  }

  if (!isSegmentMode(body.mode)) {
    throw new AppError('DATA_VALIDATION', 'mode 必須為 driving / walking / transit');
  }
  const mode = body.mode;
  // PATCH 語意：省略 submode = 保留現值（非清除）。保護不帶 submode 的 caller
  // （EditEntryPage 3-mode 編輯器只送 {mode, min}）不把 pill 設好的 monorail/bus
  // 洗成 null。顯式帶值才覆寫；mode 非 transit 由 sanitizeSubmode 強制 null。
  const submode = sanitizeSubmode(body.submode === undefined ? seg.submode : body.submode, mode);

  // v2.55.45: min 有帶就必須合法（1–1440）；不帶 = 走自動算（driving/walking/monorail/bus）。
  // 純手填方式（metro/train/hsr/自由文字/大眾運輸）缺 min 由 resolveSegmentTravel throw 400。
  if (body.min !== undefined && !isValidMin(body.min)) {
    throw new AppError('DATA_VALIDATION', 'min 須為 1–1440 分鐘');
  }

  const now = Date.now();
  const travel = await resolveSegmentTravel(context.env, db, seg.from_entry_id, seg.to_entry_id, mode, submode, body.min, now);

  // 選了真實交通方式 → no_travel=NULL 清「同一地點」旗標（un-mark），恢復正常交通段。
  let updated;
  if (travel.ok) {
    updated = await db
      .prepare(
        `UPDATE trip_segments
         SET mode = ?, submode = ?, min = ?, distance_m = ?,
             source = ?, computed_at = ?, updated_at = ?, no_travel = NULL,
             version = version + 1
         WHERE id = ? RETURNING ${SEGMENT_RETURNING_COLS}`,
      )
      .bind(mode, travel.submode, travel.min, travel.distanceM, travel.source, travel.computedAt, now, sid)
      .first();
  } else {
    // 軟失敗（缺 coords / API key / Routes error / quota lock）→ 改 mode + submode，保留舊
    // min/distance，computed_at=NULL 標 stale（不阻擋切換）。
    // source=NULL：軟失敗只發生在「自動」嘗試（手填路徑必 ok:true 或 throw），故清掉舊的
    // 'manual' 鎖定，否則 recompute 的 `source IS NOT 'manual'` guard 會永遠跳過 → 不自癒
    // + 前端假顯 🔒/恢復鈕（correctness review Finding 1）。對齊 POST 的 travel.ok?…:null。
    updated = await db
      .prepare(
        `UPDATE trip_segments
         SET mode = ?, submode = ?, source = NULL, computed_at = NULL, updated_at = ?, no_travel = NULL,
             version = version + 1
         WHERE id = ? RETURNING ${SEGMENT_RETURNING_COLS}`,
      )
      .bind(mode, submode, now, sid)
      .first();
  }
  if (!updated) throw new AppError('DATA_NOT_FOUND', 'segment 已不存在');
  return json(updated);
};
