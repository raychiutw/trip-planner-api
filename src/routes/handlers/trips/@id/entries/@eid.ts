import { logAudit, computeDiff } from '../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth, requireTripReadAccess } from '../../../../../lib/permissions';
import { AppError } from '../../../../../errors';
import { getAuth } from '../../../../../lib/utils';
import { TIME_RE, parseTime } from '../../../../../lib/time';
import { detectGarbledText } from '../../../../../lib/validate';
import { json, parseJsonBody, parseIntParam, buildUpdateClause } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';
import { fetchEntryPoisByEntries } from '../../../../../lib/day-merge';
import { resortDayByArrival } from '../../../../../lib/entry-sort';

// Phase 3：移除 location / maps / rating — 這些欄位已 DROP，POI master JOIN 取代。
// v2.30.15: mapcode 也已 DROP (migration 0066) — Google/Apple Map link 涵蓋導航需求。
// POI 重掛走 PUT /api/trips/:id/entries/:eid/poi-id（獨立端點，驗證 POI 存在）。
// v2.10 Wave 1 (Item 3 move 跨天)：加 day_id — 須驗證 targetDay 屬於同 trip，
// 不可改成不同 trip 的 day_id（防越權）。
// v2.26.0 (migration 0056)：start_time / end_time 拆分 time。dual-write 觀察期：
//   - body 若帶 start_time/end_time → 寫入 start/end + 同步 compose 寫 time
//   - body 若帶 time（legacy）→ 寫 time + parseTime compose start/end
// helpers (TIME_RE / parseTime) 共用 _time.ts。
// v2.29.0: trip_entries.{time, travel_type, travel_desc, travel_min} DROPPED.
// PATCH 不再 accept 這些 field（schema 已無對應 col）。
// v2.33.108: `version` 不在 ALLOWED_FIELDS — autosave 透過 body.expectedVersion 做 OCC，
// version 由 SQL CAS 自動 bump（SET version = version + 1）。
// migration 0078: trip_entries.note DROPPED — 備註改為 per-(entry, poi)，掛在
// trip_entry_pois.note（正選 sort_order=1 / 備選 sort_order>1）。改走
// PATCH /api/trips/:id/entries/:eid/pois/:poiId。此處不再 accept 'note'，帶 note
// 會被 buildUpdateClause 的 whitelist 過濾掉（mass-assignment 防護）。
// Legacy entry title is no longer writable; display is primary POI name.
const ALLOWED_FIELDS = ['day_id', 'sort_order', 'start_time', 'end_time', 'description', 'source'] as const;

/**
 * GET /api/trips/:id/entries/:eid → single entry meta + canonical entry POIs.
 *
 * v2.19.13: EntryActionPage (move/copy) 載 entry 當前 day_id 用,本來在 prod
 * 沒這 handler 直接 405,move/copy flow broken。讀權限走 hasPermission (viewer
 * 也可看)。
 *
 * migration 0078: trip_entries.note DROPPED。SELECT * 自然不再帶 entry-level note；
 * 「正選備註」改由 master.note（fetchEntryPoisByEntries surface 的 sort_order=1 row）提供，
 * 每個 alternate 各自的 note 也在 alternates[].note / stop_pois[].note。
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { id, eid: eidStr } = context.params as { id: string; eid: string };
  const eid = parseIntParam(eidStr);
  if (!eid) throw new AppError('DATA_VALIDATION', 'ID 格式錯誤');
  const db = context.env.DB;

  // v2.33.97 security: 對齊 sibling read endpoints (days.ts, segments/index.ts,
  // [id].ts) 走 requireTripReadAccess — published trip 允許 anonymous read，
  // 否則 owner / member only。之前 requireAuth 讓 anon 對 published trip
  // 401 with sibling endpoint contract drift。
  const [_access, belongsToTrip] = await Promise.all([
    requireTripReadAccess(db, getAuth(context), id),
    verifyEntryBelongsToTrip(db, eid, id),
  ]);
  void _access;
  if (!belongsToTrip) throw new AppError('DATA_NOT_FOUND');

  const row = await db
    .prepare('SELECT * FROM trip_entries WHERE id = ?')
    .bind(eid)
    .first<Record<string, unknown>>();
  if (!row) throw new AppError('DATA_NOT_FOUND');

  const entryPois = await fetchEntryPoisByEntries(db, [eid]);
  const bucket = entryPois.get(eid) ?? { master: null, alternates: [], stopPois: [], version: String(row.entry_pois_version ?? 0) };
  const master = bucket.master;
  const { poi_id: _legacyPoiId, ...entryFields } = row;
  void _legacyPoiId;

  return json({
    ...entryFields,
    master,
    alternates: bucket.alternates,
    stop_pois: bucket.stopPois,
    entry_pois_version: bucket.version,
  });
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, eid: eidStr } = context.params as { id: string; eid: string };
  const eid = parseIntParam(eidStr);
  if (!eid) throw new AppError('DATA_VALIDATION', 'ID 格式錯誤');
  const db = context.env.DB;
  const changedBy = auth.email;

  const [hasPerm, belongsToTrip] = await Promise.all([
    hasWritePermission(db, auth, id),
    verifyEntryBelongsToTrip(db, eid, id),
  ]);
  if (!hasPerm) throw new AppError('PERM_DENIED');
  if (!belongsToTrip) throw new AppError('DATA_NOT_FOUND');

  const oldRow = await db.prepare('SELECT * FROM trip_entries WHERE id = ?').bind(eid).first() as Record<string, unknown> | null;
  if (!oldRow) throw new AppError('DATA_NOT_FOUND');

  const body = await parseJsonBody<Record<string, unknown>>(context.request);

  // 亂碼偵測：寫入 DB 前檢查文字欄位
  // migration 0078: 'note' 移除 — entry-level note 已 DROP，per-POI note 的亂碼偵測
  // 由 PATCH /entries/:eid/pois/:poiId 端點負責。
  const textFields = ['description'];
  for (const f of textFields) {
    if (f in body && typeof body[f] === 'string' && detectGarbledText(body[f] as string)) {
      throw new AppError('DATA_ENCODING', `欄位 ${f} 包含疑似亂碼，請確認 encoding 為 UTF-8`);
    }
  }

  // v2.10 Wave 1: day_id move 跨天驗證 — 防止把 entry 移到別 trip 的 day。
  if ('day_id' in body) {
    const targetDayId = body.day_id;
    if (typeof targetDayId !== 'number' || !Number.isInteger(targetDayId) || targetDayId <= 0) {
      throw new AppError('DATA_VALIDATION', 'day_id 必須是正整數');
    }
    const targetDay = await db
      .prepare('SELECT trip_id FROM trip_days WHERE id = ?')
      .bind(targetDayId)
      .first() as { trip_id: string } | null;
    if (!targetDay) throw new AppError('DATA_NOT_FOUND', '指定的 day 不存在');
    if (targetDay.trip_id !== id) throw new AppError('PERM_DENIED', '不可將 entry 移到其他 trip');
  }

  // v2.29.0: trip_entries.time DROPPED. 只接受 start_time / end_time。
  // 為 backward-compat 仍接 legacy body.time → parse 拆成 start/end（但不寫回 time col）。
  for (const f of ['start_time', 'end_time'] as const) {
    if (f in body && body[f] !== null && body[f] !== '' && typeof body[f] === 'string') {
      if (!TIME_RE.test(body[f] as string)) {
        throw new AppError('DATA_VALIDATION', `${f} 必須符合 HH:MM 格式`);
      }
    }
  }
  if ('start_time' in body || 'end_time' in body) {
    const start = ('start_time' in body ? body.start_time : oldRow.start_time) as string | null | undefined;
    const end = ('end_time' in body ? body.end_time : oldRow.end_time) as string | null | undefined;
    // 驗證 effective merge state（不只看 body）— 防 client 只送 start_time
    // 但 oldRow 既有 end_time 比新 start_time 早造成 inverted range。
    if (typeof start === 'string' && typeof end === 'string' && start && end && start >= end) {
      throw new AppError('DATA_VALIDATION', 'start_time 必須早於 end_time');
    }
  } else if ('time' in body && typeof body.time === 'string') {
    const parsed = parseTime(body.time);
    body.start_time = parsed.start;
    body.end_time = parsed.end;
    delete body.time;
  } else if ('time' in body && body.time === null) {
    body.start_time = null;
    body.end_time = null;
    delete body.time;
  }

  // v2.33.108: OCC token — autosave hook 帶 expectedVersion；不符 → 409 STALE_ENTRY
  // 讓 client refresh + retry。omit → backward compat skip check（但 version 仍 bump）。
  const expectedVersion = typeof body.expectedVersion === 'number'
    && Number.isInteger(body.expectedVersion)
    ? body.expectedVersion
    : null;
  if (expectedVersion !== null) delete body.expectedVersion;

  const update = buildUpdateClause(body, ALLOWED_FIELDS);
  if (!update) throw new AppError('DATA_VALIDATION', '無有效欄位可更新');

  // 一律 atomic SET version = version + 1（無 OCC token 時 backward-compat 仍 bump）
  const setClausesWithVersion = `${update.setClauses}, version = version + 1`;

  let row;
  try {
    if (expectedVersion !== null) {
      // OCC CAS：UPDATE only if version matches
      row = await db
        .prepare(`UPDATE trip_entries SET ${setClausesWithVersion} WHERE id = ? AND version = ? RETURNING *`)
        .bind(...update.values, eid, expectedVersion)
        .first();
      if (!row) {
        // CAS fail — version mismatch（或 row 同時被 deleted）
        const cur = await db.prepare('SELECT version FROM trip_entries WHERE id = ?').bind(eid).first<{ version: number }>();
        if (!cur) throw new AppError('DATA_NOT_FOUND');
        throw new AppError('STALE_ENTRY', `expected version ${expectedVersion}, current ${cur.version}`);
      }
    } else {
      row = await db
        .prepare(`UPDATE trip_entries SET ${setClausesWithVersion} WHERE id = ? RETURNING *`)
        .bind(...update.values, eid)
        .first();
    }
  } catch (err: unknown) {
    // Re-throw our own AppErrors (e.g. STALE_ENTRY / DATA_NOT_FOUND raised inside
    // the try) so they keep their intended status instead of being swallowed and
    // remapped to 503. Canonical guard, mirrors notes/_shared.ts.
    if (err instanceof AppError) throw err;
    // v2.33.43 security audit: re-classify constraint failures to 409 (was
    // silently swallowed as 503，UX 與 client retry 邏輯都受影響).
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint/i.test(msg) || /SQLITE_CONSTRAINT_UNIQUE/i.test(msg)) {
      throw new AppError('DATA_CONFLICT', '此 entry 與既有資料衝突');
    }
    if (/FOREIGN KEY constraint/i.test(msg) || /SQLITE_CONSTRAINT_FOREIGNKEY/i.test(msg)) {
      throw new AppError('DATA_VALIDATION', '欄位參考的資料不存在');
    }
    throw new AppError('SYS_DB_ERROR', 'DB 暫時無法處理，請稍後重試');
  }

  if (!row) throw new AppError('DATA_NOT_FOUND');

  const newFields = Object.fromEntries(update.fields.map(f => [f, body[f]]));
  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entries',
    recordId: eid,
    action: 'update',
    changedBy,
    diffJson: computeDiff(oldRow, newFields),
  });

  // 依抵達時間重排：改了 start_time 且未顯式指定 sort_order → 重排當日 entries
  // （手動拖曳走 batch 端點顯式 sort_order，不進這裡；inline 與全頁改時間都覆蓋）。
  // travel 重算由前端 dispatch entryUpdated + requestTravelRecompute 觸發。
  // best-effort：entry UPDATE 已 commit（D1 逐語句 auto-commit），重排失敗不可讓主寫入
  // 回報 500（否則前端誤報「時間儲存失敗」且跳過 recompute，但時間其實已存）；resort
  // 自癒、下次改時間會補正。
  if ('start_time' in body && !('sort_order' in body)) {
    try {
      await resortDayByArrival(db, Number((row as { day_id?: unknown }).day_id));
    } catch (err) {
      console.error('[entries PATCH] resortDayByArrival failed (non-fatal)', err);
    }
  }

  // 注意：回傳的 row 帶「重排前」的 sort_order（stale）；不影響 client——前端一律 refetch
  // 當日、不採用此 sort_order。省一次 re-read。
  return json(row);
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, eid: eidStr } = context.params as { id: string; eid: string };
  const eid = parseIntParam(eidStr);
  if (!eid) throw new AppError('DATA_VALIDATION', 'ID 格式錯誤');
  const db = context.env.DB;
  const changedBy = auth.email;

  const [hasPerm2, belongsToTrip2] = await Promise.all([
    hasWritePermission(db, auth, id),
    verifyEntryBelongsToTrip(db, eid, id),
  ]);
  if (!hasPerm2) throw new AppError('PERM_DENIED');
  if (!belongsToTrip2) throw new AppError('DATA_NOT_FOUND');

  const oldRow = await db.prepare('SELECT * FROM trip_entries WHERE id = ?').bind(eid).first() as Record<string, unknown> | null;
  if (!oldRow) throw new AppError('DATA_NOT_FOUND');

  // v2.29.0: trip_pois DROPPED. trip_entry_pois has ON DELETE CASCADE so the entry delete cascades.
  try {
    await db.prepare('DELETE FROM trip_entries WHERE id = ?').bind(eid).run();
  } catch (err: unknown) {
    // v2.33.43 security audit: re-classify FK constraint failures.
    const msg = err instanceof Error ? err.message : String(err);
    if (/FOREIGN KEY constraint/i.test(msg) || /SQLITE_CONSTRAINT_FOREIGNKEY/i.test(msg)) {
      throw new AppError('DATA_CONFLICT', '此 entry 仍有相依資料無法刪除');
    }
    throw new AppError('SYS_DB_ERROR', 'DB 暫時無法處理，請稍後重試');
  }

  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entries',
    recordId: eid,
    action: 'delete',
    changedBy,
    snapshot: JSON.stringify(oldRow),
  });

  return json({ ok: true });
};
