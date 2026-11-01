/**
 * POST /api/trips/:id/recompute-travel?day=N|all
 *
 * v2.24.0 trip-segments：
 *   - 1km gate（Haversine 本地算）：≤1km → walking + WALK API；>1km → driving + DRIVE API
 *   - driving/walking 永遠 1 Google Routes call/pair（不打 Google TRANSIT — Japan 無資料）
 *   - 寫 trip_segments（first-class，v2.29.0 為唯一 source，entry.travel_* 已 DROPPED）
 *
 * v2.55.45（交通方式 submode 自動算）／v2.55.72（非單軌 transit 一律預設 DRIVE）：
 *   - transit + submode='monorail'（沖繩單軌）→ 本地 Yui 估重算（walk+單軌+walk，0 API）。
 *   - 其餘 transit（bus/metro/train/hsr/自由文字/null）→ 預設用駕車 Google DRIVE 重算，
 *     submode 原樣保留（v2.55.72 起 metro/train/hsr 也自動，不再落入「假設 manual 而跳過」）。
 *   - source='manual'（手填 / 手動覆寫鎖定）→ 一律跳過不覆寫（取代舊 mode!='transit' 判斷）。
 *
 * v2.30.0（mode_source DROPPED）：
 *   - mode='transit' 既有 segment 不覆寫（user 手填 min，recompute 不能蓋）
 *   - 切回 driving / walking 由 PATCH /segments/:sid 觸發 Google Routes 重算
 *
 * v2.55.43（orphan prune trip-wide）：
 *   - 每次 recompute（含 day=N）都 trip-wide 清掉幽靈段（reorder / 刪景點殘留的
 *     非相鄰段），非只 scoped day。刪景點觸發的 day=N recompute 也連帶清全 trip 孤兒。
 *   - 載入全 trip entries 建 allTripPairKeys，只 compute scoped day → subrequest 不變。
 *
 * Self-drive 窗內也吃 1km gate（短程仍 walking — 找停車位比走路慢）。
 *
 * Subrequest budget（CF Pages Free 50/invocation）：
 *   1 (assertGoogleAvailable) + 1 (trip) + 1 (days) + 1 (all-entries SELECT)
 *     + 1 (existing segments preload) + 47 (Routes calls per pair) + 1 (db.batch)
 *   ~52 for HuiYun 47 pairs；約莫擦邊。day filter recompute 永遠安全
 *   （trip-wide entries load 仍 1 query；Routes 只算 scoped day）。
 *
 * Auth: trip write permission.
 */

import { requireAuth, requireTripWrite } from '../../../../lib/permissions';
import { logAudit } from '../../../../lib/audit';
import { AppError } from '../../../../errors';
import { json } from '../../../../lib/utils';
import { assertGoogleAvailable } from '../../../../lib/maps-lock';
import { computeRoute } from '../../../../lib/maps/google-client';
import { haversineMeters } from '../../../../lib/geo';
import { computeYuiTravel } from '../../../../lib/yuiRail';
import type { Env } from '../../../../env';

const WALK_GATE_M = 1000;

interface EntryWithCoords {
  id: number;
  day_id: number;
  sort_order: number;
  lat: number | null;
  lng: number | null;
}

interface TripDay {
  id: number;
  day_num: number;
}

interface ExistingSegment {
  id: number;
  from_entry_id: number;
  to_entry_id: number;
  mode: string;
  submode: string | null;
  source: string | null;
  /** v2.55.46: 1 = 同一地點/免交通 → recompute 跳過不覆寫（同 source='manual' lock）。 */
  no_travel: number | null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const tripId = context.params.id as string;
  if (!tripId) throw new AppError('DATA_VALIDATION', '缺少 tripId');

  const db = context.env.DB;
  await requireTripWrite(db, auth, tripId);

  const trip = await db.prepare('SELECT id FROM trips WHERE id = ?').bind(tripId).first();
  if (!trip) throw new AppError('DATA_NOT_FOUND', '找不到該行程');

  const apiKey = context.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new AppError('MAPS_UPSTREAM_FAILED', 'GOOGLE_MAPS_API_KEY not configured');
  await assertGoogleAvailable(db);

  const url = new URL(context.request.url);
  const dayParam = url.searchParams.get('day');
  let dayNumFilter: number | null = null;
  if (dayParam && dayParam !== 'all') {
    const n = parseInt(dayParam, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new AppError('DATA_VALIDATION', 'day 必須為正整數或 all');
    }
    dayNumFilter = n;
  }

  const daysSql = dayNumFilter !== null
    ? 'SELECT id, day_num FROM trip_days WHERE trip_id = ? AND day_num = ? ORDER BY day_num'
    : 'SELECT id, day_num FROM trip_days WHERE trip_id = ? ORDER BY day_num';
  const daysBind = dayNumFilter !== null ? [tripId, dayNumFilter] : [tripId];
  const daysRes = await db.prepare(daysSql).bind(...daysBind).all<TripDay>();

  // Pre-load 既有 segments（單一 SELECT 省 N 次 per-pair query）
  const existingRes = await db
    .prepare('SELECT id, from_entry_id, to_entry_id, mode, submode, source, no_travel FROM trip_segments WHERE trip_id = ?')
    .bind(tripId)
    .all<ExistingSegment>();
  const existingMap = new Map<string, ExistingSegment>();
  for (const s of existingRes.results) {
    existingMap.set(`${s.from_entry_id}-${s.to_entry_id}`, s);
  }

  let pairsComputed = 0;
  let pairsSkippedTransit = 0;
  let pairsSkippedMissingCoords = 0;
  const sourceBreakdown: Record<string, number> = {};
  const modeBreakdown: Record<string, number> = {};
  const errorsDetail: Array<{ entryId: number; message: string }> = [];

  // 收集 batch statements 最後一次 db.batch 寫入（單一 subrequest）
  const segmentInserts: Array<{ tripId: string; from: number; to: number; mode: string; min: number; distM: number; now: number }> = [];
  const segmentUpdates: Array<{ id: number; mode: string; min: number; distM: number; now: number }> = [];
  // v2.55.45: transit 自動方式的重算寫入（帶 submode + source，走獨立 UPDATE）。
  // v2.55.72: submode 放寬為 string | null（bus/metro/train/hsr/自由文字/null 皆走 DRIVE 保留原 submode）。
  const transitUpdates: Array<{ id: number; submode: string | null; min: number; distM: number | null; source: string; now: number }> = [];
  // v2.29.0: trip_entries.travel_* DROPPED. trip_segments 為唯一 source.

  // v2.55.43: 載入「整個 trip」的 entries（不論 day filter）建 allTripPairKeys。
  // compute 只跑 scoped day（daysRes 已 filter），但 orphan prune 要 trip-wide —
  // 否則 day=N recompute 清不掉其他天殘留的幽靈段。改 trip_id JOIN（非 day_id IN）
  // 仍是 1 subrequest；30-day trip 也只 1 query。
  // 註：day filter 指不到任何 day（如 ?day=99）時 daysRes 為空 → 不 compute，但仍
  // 載入全 trip entries 做 trip-wide prune（刻意；舊 day-scoped 版是 no-op）。
  const allEntriesRes = await db
    .prepare(
      `SELECT e.id, e.day_id, e.sort_order, p.lat, p.lng
       FROM trip_entries e
       JOIN trip_days d ON d.id = e.day_id
       LEFT JOIN trip_entry_pois tep ON tep.entry_id = e.id AND tep.sort_order = 1
       LEFT JOIN pois p ON p.id = tep.poi_id
       WHERE d.trip_id = ?
       ORDER BY e.day_id ASC, e.sort_order ASC`,
    )
    .bind(tripId)
    .all<EntryWithCoords>();
  const entriesByDay = new Map<number, EntryWithCoords[]>();
  for (const row of allEntriesRes.results) {
    const arr = entriesByDay.get(row.day_id) ?? [];
    arr.push(row);
    entriesByDay.set(row.day_id, arr);
  }
  // 全 trip 現行相鄰對（prune 白名單）：不在此集合的 segment = 幽靈 → 清。
  // Invariant：合法 segment 一律是「同日相鄰對」（timeline 車程只連同日相鄰 entry；
  // TpMap / buildSegments 也只認同日段）。跨日 / 非相鄰段皆為 junk，刻意 prune 掉。
  // 若日後加「跨日交通」（如過夜渡輪）需先在寫入端（POST /segments、import、clone）
  // 放行並改此白名單邏輯，否則會被下次 recompute 清掉。
  const allTripPairKeys = new Set<string>();
  for (const list of entriesByDay.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (prev && curr) allTripPairKeys.add(`${prev.id}-${curr.id}`);
    }
  }

  const now = Date.now();
  for (const day of daysRes.results) {
    const list = entriesByDay.get(day.id) ?? [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (!prev || !curr) continue;
      const pairKey = `${prev.id}-${curr.id}`;
      if (prev.lat == null || prev.lng == null || curr.lat == null || curr.lng == null) {
        pairsSkippedMissingCoords++;
        continue;
      }

      const existing = existingMap.get(pairKey);
      // 一律不覆寫：使用者手填/覆寫鎖定（source='manual'）或標記「同一地點/免交通」（no_travel=1）。
      // 兩個訊號都 load-bearing 非冗餘：no_travel 段 source 不設 'manual'（POST/PATCH 存 NULL），
      // 且 import 可產生 no_travel=1 + 非 manual source → no_travel===1 是此類段唯一的 skip 訊號。
      if (existing && (existing.source === 'manual' || existing.no_travel === 1)) {
        pairsSkippedTransit++;
        continue;
      }
      // 自動算的 transit 方式：monorail（本地 Yui 估、0 API）/ bus（同駕車走 DRIVE）。
      // NOTE：此 submode→策略 dispatch 與 segments/_shared.ts resolveSegmentTravel 概念重複，
      // 但刻意 inline —— batch 情境已握有 prev/curr in-memory 座標，避免 per-pair 走 _shared 的
      // 座標 DB 查詢（會爆 CF 50 subrequest 預算）。新增自動 submode 時兩處都要改。
      if (existing && existing.mode === 'transit') {
        if (existing.submode === 'monorail') {
          const yui = computeYuiTravel({ lat: prev.lat, lng: prev.lng }, { lat: curr.lat, lng: curr.lng });
          if (yui.ok) {
            transitUpdates.push({ id: existing.id, submode: 'monorail', min: yui.min, distM: yui.distanceM, source: 'haversine', now });
            sourceBreakdown['haversine'] = (sourceBreakdown['haversine'] ?? 0) + 1;
            modeBreakdown['transit'] = (modeBreakdown['transit'] ?? 0) + 1;
            pairsComputed++;
          } else {
            // 景點移動後兩端離站太遠 / 同站 → 無法重算，保留舊值不覆寫。
            pairsSkippedTransit++;
          }
          continue;
        }
        // 其餘 transit（bus/metro/train/hsr/自由文字/null）→ v2.55.72 起一律預設 Google DRIVE
        // 估（同 _shared resolveSegmentTravel）。submode 原樣保留當 label。手填鎖定
        // （source='manual'）已於上方 skip，不會到這。
        try {
          const result = await computeRoute(apiKey, { lat: prev.lat, lng: prev.lng }, { lat: curr.lat, lng: curr.lng }, 'DRIVE');
          transitUpdates.push({
            id: existing.id,
            submode: existing.submode,
            min: Math.round(result.duration_seconds / 60),
            distM: result.distance_meters,
            source: 'google',
            now,
          });
          sourceBreakdown['google'] = (sourceBreakdown['google'] ?? 0) + 1;
          modeBreakdown['transit'] = (modeBreakdown['transit'] ?? 0) + 1;
          pairsComputed++;
        } catch (err) {
          sourceBreakdown['error'] = (sourceBreakdown['error'] ?? 0) + 1;
          const detail = err instanceof AppError ? (err.detail ?? err.message) : (err instanceof Error ? err.message : String(err));
          errorsDetail.push({ entryId: curr.id, message: detail.slice(0, 200) });
          if (err instanceof AppError && err.code === 'MAPS_LOCKED') throw err;
        }
        continue;
      }

      // 1km gate（pure local Haversine — 0 API call）
      const distHaversine = haversineMeters(
        { lat: prev.lat, lng: prev.lng },
        { lat: curr.lat, lng: curr.lng },
      );
      const chosenMode: 'walking' | 'driving' = distHaversine <= WALK_GATE_M ? 'walking' : 'driving';
      const apiMode: 'WALK' | 'DRIVE' = chosenMode === 'walking' ? 'WALK' : 'DRIVE';

      try {
        const result = await computeRoute(
          apiKey,
          { lat: prev.lat, lng: prev.lng },
          { lat: curr.lat, lng: curr.lng },
          apiMode,
        );

        const minutes = Math.round(result.duration_seconds / 60);
        const distM = result.distance_meters;

        if (existing) {
          segmentUpdates.push({ id: existing.id, mode: chosenMode, min: minutes, distM, now });
        } else {
          segmentInserts.push({ tripId, from: prev.id, to: curr.id, mode: chosenMode, min: minutes, distM, now });
        }
        // v2.29.0: trip_entries.travel_* DROPPED, no dual-write to legacy cols.

        sourceBreakdown['google'] = (sourceBreakdown['google'] ?? 0) + 1;
        modeBreakdown[chosenMode] = (modeBreakdown[chosenMode] ?? 0) + 1;
        pairsComputed++;
      } catch (err) {
        sourceBreakdown['error'] = (sourceBreakdown['error'] ?? 0) + 1;
        const detail = err instanceof AppError ? (err.detail ?? err.message) : (err instanceof Error ? err.message : String(err));
        errorsDetail.push({ entryId: curr.id, message: detail.slice(0, 200) });
        if (err instanceof AppError && err.code === 'MAPS_LOCKED') throw err;
      }
    }
  }

  const staleSegmentDeletes = existingRes.results
    .filter((s) => !allTripPairKeys.has(`${s.from_entry_id}-${s.to_entry_id}`))
    .map((s) => s.id);

  // 單一 db.batch 寫入所有 upserts（1 subrequest 不論 statement 數）
  if (segmentInserts.length > 0 || segmentUpdates.length > 0 || transitUpdates.length > 0 || staleSegmentDeletes.length > 0) {
    const stmts = [
      // entry reorder / move / 刪景點後，舊 from→to 兩端 entry 都還在（非 FK cascade
      // 能清），只是不再相鄰。每次 recompute 都 trip-wide 清掉所有「不是任何一天現行
      // 相鄰對」的幽靈段（含非 scoped day 的殘留）。
      ...staleSegmentDeletes.map((id) => db.prepare(
        'DELETE FROM trip_segments WHERE id = ?',
      ).bind(id)),
      // INSERT 用 ON CONFLICT 防 TOCTOU race：preload 後若另一支 concurrent
      // recompute 已 INSERT 同 (from,to) pair，本 batch 不會炸 UNIQUE → atomic
      // rollback；改成 upsert。WHERE source IS NOT 'manual' 防 race（v2.55.45 泛化自
      // 舊 mode!='transit'）：preload→write 之間若 user 手填/手動覆寫鎖定則不蓋。
      // IS NOT 為 null-safe（source 可 NULL；`NULL != 'manual'` 會是 NULL 而非 true）。
      // driving/walking 一律 submode=NULL（不變式：submode 非 null ⟺ mode=transit）。
      // 顯式清 submode 防 TOCTOU race：若 ON CONFLICT 撞到已是 monorail 的 row，
      // 不留下 mode=driving + submode=monorail 的髒資料。
      ...segmentInserts.map((s) => db.prepare(
        `INSERT INTO trip_segments
         (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'google', ?, ?)
         ON CONFLICT (from_entry_id, to_entry_id) DO UPDATE SET
           mode = excluded.mode,
           submode = NULL,
           min = excluded.min,
           distance_m = excluded.distance_m,
           source = 'google',
           computed_at = excluded.computed_at,
           updated_at = excluded.updated_at
         WHERE trip_segments.source IS NOT 'manual' AND trip_segments.no_travel IS NOT 1`,
      ).bind(s.tripId, s.from, s.to, s.mode, s.min, s.distM, s.now, s.now)),
      // driving/walking UPDATE guard source IS NOT 'manual'（同上，保護使用者鎖定值）。
      ...segmentUpdates.map((s) => db.prepare(
        `UPDATE trip_segments
         SET mode = ?, submode = NULL, min = ?, distance_m = ?,
             source = 'google', computed_at = ?, updated_at = ?
         WHERE id = ? AND source IS NOT 'manual' AND no_travel IS NOT 1`,
      ).bind(s.mode, s.min, s.distM, s.now, s.now, s.id)),
      // v2.55.45: transit 自動方式（monorail/bus）重算 — 帶 submode + 各自 source
      // （monorail=haversine、bus=google）。guard 同 source IS NOT 'manual'。
      ...transitUpdates.map((s) => db.prepare(
        `UPDATE trip_segments
         SET mode = 'transit', submode = ?, min = ?, distance_m = ?,
             source = ?, computed_at = ?, updated_at = ?
         WHERE id = ? AND source IS NOT 'manual' AND no_travel IS NOT 1`,
      ).bind(s.submode, s.min, s.distM, s.source, s.now, s.now, s.id)),
    ];
    await db.batch(stmts);
  }

  // PR32: audit log for recompute-travel bulk batch（recordId=null + 摘要）
  await logAudit(db, {
    tripId,
    tableName: 'trip_segments',
    recordId: null,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({
      op: 'recompute-travel',
      daysProcessed: daysRes.results.length,
      pairsComputed,
      pairsSkippedTransit,
      pairsSkippedMissingCoords,
      segmentsPruned: staleSegmentDeletes.length,
      sourceBreakdown,
      modeBreakdown,
    }),
  });

  return json({
    ok: true,
    tripId,
    daysProcessed: daysRes.results.length,
    pairsComputed,
    pairsSkippedTransit,
    pairsSkippedMissingCoords,
    segmentsPruned: staleSegmentDeletes.length,
    sourceBreakdown,
    modeBreakdown,
    errorsDetail,
  });
};
