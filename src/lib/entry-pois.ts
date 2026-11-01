/**
 * _entry_pois.ts — trip_entry_pois 操作 helper（v2.27.0 multi-POI per entry）
 *
 * Design 紀要 + Phase 1 → Phase 2 cutover 細節：見 PR / commit body + migration
 * 0057 / 0058 header 註解。
 *
 * ## 核心 invariants
 *
 * 1. **sort_order=1 即 master**：UNIQUE (entry_id, sort_order) 保證單一 master
 * 2. **At-least-one master**：每 entry 必有 sort_order=1 row（backend enforce）
 * 3. **UNIQUE (entry_id, poi_id)**：同 POI 不能在同 entry 出現兩次
 * 4. ~~trip_entries.poi_id dual-write~~ — v2.29.0 DROP COLUMN，setMaster() 只寫 trip_entry_pois
 *
 * ## OCC（樂觀並發控制）
 *
 * 對抗 Codex Finding #1 CRITICAL — dual-write race。`getEntryPoisVersion()` 取
 * **trip_entries.updated_at** 當 version token（round 4 fix Codex F2：原本用
 * MAX(updated_at) FROM trip_entry_pois 在 removeAlternate 後可能 backward — 移除
 * max-ts row 後 MAX 變回更舊 ts，舊 token 重新有效）。所有 mutating helper
 * （setMaster / addAlternate / removeAlternate / reorderAlternates）都會 bump
 * trip_entries.updated_at = nowMs() 保證 monotonic。
 *
 * ## Master swap TX 邏輯（Codex Finding #2）
 *
 * SQLite UNIQUE 是 immediate enforcement，兩個直接 UPDATE 會 collide。改用
 * temp_order = max+100 暫時 vacate sort_order=1，三段 UPDATE 包在 D1 batch
 * (implicit TX, rollback on failure)。
 *
 * ## Segment recompute（Codex Finding #3）
 *
 * setMaster() 在 batch 內 mark trip_segments computed_at=NULL + updated_at=Date.now()
 * (ms — round 4 Codex F5 fix；原本用 strftime('%s') seconds 跟 recompute-travel
 * 的 Date.now() ms 不同 scale)。trip_segments.source CHECK 不允許 'stale'，所以
 * 只能用 computed_at=NULL signal。實際 Google Routes call 由 frontend useTripSegments
 * 在 computed_at=NULL detect 後觸發 POST /recompute-travel idempotent。
 */
import { AppError } from '../errors';

/** @internal — exported for syncEntryMaster collision-route to setMaster. */
export interface MasterPoiRow {
  poiId: number;
  name: string | null;
  lat: number | null;
  lng: number | null;
  type: string | null;
  category: string | null;
}

/** @internal — used inside reorderAlternates only. Do not call from endpoints. */
interface AlternatePoiRow extends MasterPoiRow {
  sortOrder: number;
}

/** 取 entry 所有 alternates（sort_order > 1，依 sort_order 排序）。 @internal */
async function getAlternates(
  db: D1Database,
  entryId: number,
): Promise<AlternatePoiRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS poi_id, p.name, p.lat, p.lng, p.type, p.category, tep.sort_order
       FROM trip_entry_pois tep
       JOIN pois p ON p.id = tep.poi_id
       WHERE tep.entry_id = ? AND tep.sort_order > 1
       ORDER BY tep.sort_order ASC`,
    )
    .bind(entryId)
    .all<{ poi_id: number; name: string | null; lat: number | null; lng: number | null; type: string | null; category: string | null; sort_order: number }>();
  return results.map((r) => ({
    poiId: r.poi_id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    type: r.type,
    category: r.category,
    sortOrder: r.sort_order,
  }));
}

/**
 * OCC version token = trip_entries.entry_pois_version (integer counter, migration 0058).
 *
 * Round 4 attempted to fix Codex F2 (version backward) by switching to
 * trip_entries.updated_at. Round 5 found that this:
 *   1. mismatched the GET path (MAX(trip_entry_pois.updated_at)) → fresh clients 409
 *   2. cross-mutation false-positive — PATCH /entries note edit bumps updated_at,
 *      invalidating outstanding tokens
 *
 * Round 5 fix: dedicated integer counter on trip_entries, bumped ONLY by the 4 multi-POI
 * mutating helpers (setMaster / addAlternate / removeAlternate / reorderAlternates).
 * GET + write paths read the same column. PATCH /entries note edits do NOT touch it.
 * Returned as string so the API contract surface stays string-typed.
 */
export async function getEntryPoisVersion(
  db: D1Database,
  entryId: number,
): Promise<string> {
  const row = await db
    .prepare(`SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?`)
    .bind(entryId)
    .first<{ v: number | null }>();
  return String(row?.v ?? 0);
}

/**
 * 產生 ISO 8601 millisecond-resolution timestamp 給 trip_entry_pois.updated_at。
 * SQLite `datetime('now')` 只有 1-second 解析度，會讓 sub-second 同 entry 的兩個
 * setMaster() OCC token 相同，race window 仍開放（Codex pre-landing CRITICAL #1）。
 * 改用 JS Date ISO（ms）+ 在 application layer bind 取代 SQL inline，全部時間源
 * 統一從同一個 JS 時鐘取，避免 batch 內 statement 各自呼叫 datetime('now')。
 */
function nowMs(): string {
  return new Date().toISOString();
}

/**
 * 把 newMasterPoiId 設為 entry 的 master（sort_order=1）。
 *
 * 邏輯（per Codex Finding #2 + #3）：
 * 1. 若 expectedVersion 提供且不 match 當前 version → 409 STALE_ENTRY
 * 2. 取 max sort_order，temp_order = max + 100（safe gap，避開既有 sort_order）
 * 3. UPDATE old master SET sort_order = temp_order（vacate sort_order=1）
 * 4. IF newMasterPoiId 已在 alternates → UPDATE 它 SET sort_order = 1
 *           old master → 改回 newMaster 原本的 sort_order
 *    ELSE  → INSERT 新 row (poi_id=newMasterPoiId, sort_order=1)
 *           old master → max+1
 * 5. UPDATE trip_segments SET computed_at = NULL WHERE from_entry_id=entryId OR to_entry_id=entryId
 *    （只清 computed_at 不改 source — trip_segments.source CHECK 不允許 'stale'；
 *      frontend useTripSegments 透過 updated_at bump detect refetch；後續 Google Routes
 *      recompute 留待 v2.27.x enhancement）
 */
export async function setMaster(
  db: D1Database,
  entryId: number,
  newMasterPoiId: number,
  expectedVersion?: string,
): Promise<{ version: string; oldMasterPoiId: number | null }> {
  // 1. Parallel OCC version check + snapshot SELECTs — 4 SELECTs in one round trip when
  // expectedVersion is provided (was 1 RT for version + 1 RT for 3 parallel snapshots).
  // round 7 fix: 移除 detail string（中英混用 + 洩漏 token format）。STALE_ENTRY
  // 的 user-facing 中文 message 從 ERROR_MESSAGES catalog 取，client 需要 recover
  // 走 refetch 而非從 error message regex 解 version。
  const [versionRow, oldMasterRow, newMasterRow, maxRow] = await Promise.all([
    expectedVersion !== undefined
      ? db
          .prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?')
          .bind(entryId)
          .first<{ v: number | null }>()
      : Promise.resolve(null),
    db
      .prepare('SELECT id, poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ id: number; poi_id: number }>(),
    db
      .prepare('SELECT id, sort_order FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, newMasterPoiId)
      .first<{ id: number; sort_order: number }>(),
    db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entryId)
      .first<{ max_order: number }>(),
  ]);

  // OCC fail-fast — stringify to match getEntryPoisVersion contract (string-typed API surface).
  if (expectedVersion !== undefined && String(versionRow?.v ?? 0) !== expectedVersion) {
    throw new AppError('STALE_ENTRY');
  }
  const oldMasterPoiId = oldMasterRow?.poi_id ?? null;
  const maxOrder = maxRow?.max_order ?? 0;
  const tempOrder = maxOrder + 100;

  // No-op: already master. v2.29.0: trip_entries.poi_id DROPPED — drift repair 簡化為
  // bump updated_at + invalidate segments cache。NO entry_pois_version bump — 語意上
  // 對 multi-POI clients 沒變化，token 維持。
  if (oldMasterPoiId === newMasterPoiId) {
    const now = nowMs();
    await db.batch([
      db.prepare('UPDATE trip_entries SET updated_at = ? WHERE id = ?').bind(now, entryId),
      db.prepare(`UPDATE trip_segments SET computed_at = NULL, updated_at = ? WHERE from_entry_id = ? OR to_entry_id = ?`).bind(Date.now(), entryId, entryId),
    ]);
    const version = await getEntryPoisVersion(db, entryId);
    return { version, oldMasterPoiId };
  }

  // 統一 timestamp source — 整個 batch 內所有 updated_at 用同一個 JS-clock ISO ms
  // (Codex pre-landing CRITICAL #1 + HIGH #5)。所有 OCC token 來自此值。
  const now = nowMs();

  const statements: D1PreparedStatement[] = [];

  // OCC 策略：read-then-CAS via UNIQUE(entry_id, sort_order)。兩個並發 setMaster 都
  // 想寫 sort_order=1，UNIQUE constraint 讓 loser 失敗 → batch try/catch 抓
  // SQLITE_CONSTRAINT 轉成 STALE_ENTRY 409（Codex CRITICAL #3）。expectedVersion
  // 比對只是 happy path 短路 — 不傳 version 也安全，UNIQUE 仍會 catch race。
  if (oldMasterRow) {
    // vacate sort_order=1 → temp_order
    statements.push(
      db
        .prepare(`UPDATE trip_entry_pois SET sort_order = ?, updated_at = ? WHERE id = ?`)
        .bind(tempOrder, now, oldMasterRow.id),
    );
  }

  if (newMasterRow) {
    // SWAP path: 已存在 alternate → 升 master
    statements.push(
      db
        .prepare(`UPDATE trip_entry_pois SET sort_order = 1, updated_at = ? WHERE id = ?`)
        .bind(now, newMasterRow.id),
    );
    if (oldMasterRow) {
      // demote old master 到 newMaster 原本 slot
      statements.push(
        db
          .prepare(`UPDATE trip_entry_pois SET sort_order = ?, updated_at = ? WHERE id = ?`)
          .bind(newMasterRow.sort_order, now, oldMasterRow.id),
      );
    }
  } else {
    // INSERT path: newMaster 是 search/favorites 來的新 POI
    statements.push(
      db
        .prepare(
          `INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, added_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .bind(entryId, newMasterPoiId, now, now),
    );
    if (oldMasterRow) {
      // old master → max+1 (next alternate slot)
      statements.push(
        db
          .prepare(`UPDATE trip_entry_pois SET sort_order = ?, updated_at = ? WHERE id = ?`)
          .bind(maxOrder + 1, now, oldMasterRow.id),
      );
    }
  }

  // v2.29.0: trip_entries.poi_id DROPPED, just bump updated_at + entry_pois_version (round
  // 5 dedicated counter, only multi-POI helpers bump it, so PATCH /entries note edit doesn't
  // invalidate the OCC token).
  statements.push(
    db
      .prepare(`UPDATE trip_entries SET updated_at = ?, entry_pois_version = entry_pois_version + 1 WHERE id = ?`)
      .bind(now, entryId),
  );

  // Mark adjacent segments stale（per Codex #3）
  // trip_segments.source CHECK 不允許 'stale'，改用 computed_at=NULL 標 stale +
  // bump updated_at 讓 frontend useTripSegments 知道要 refetch。
  // round 4 fix Codex F5: bind Date.now() ms (matches recompute-travel.ts:150
  // convention) instead of strftime('%s') seconds — mixing scales made the
  // "bumped updated_at" signal move backward when this UPDATE ran right after
  // a recompute, breaking refetch detection.
  // v2.55.46: master POI 真的換掉（swap path，非上面的 no-op drift-repair）→ 端點變了，
  // 「同一地點/免交通」前提失效 → 一併清 no_travel=NULL，讓 recompute 重新計算此段
  // （否則 recompute 見 no_travel=1 永久跳過、繼續顯示對已不同地點的「同一地點」）。
  // 取捨：若只是重選「同機場另一航廈」這種仍同地點的 POI，會被重算成短程開車 → 需再標一次。
  const segUpdatedAt = Date.now();
  statements.push(
    db
      .prepare(
        `UPDATE trip_segments SET computed_at = NULL, no_travel = NULL, updated_at = ?
         WHERE from_entry_id = ? OR to_entry_id = ?`,
      )
      .bind(segUpdatedAt, entryId, entryId),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    // Codex pre-landing CRITICAL #3：並發 setMaster 走到 UNIQUE constraint
    // (entry_id, sort_order)=1 collision → catch + rethrow 為 STALE_ENTRY 給 client
    // proper 409 + retry hint，而非 opaque 500。SQL error 細節 log 到 console，
    // user-facing message 走 ERROR_MESSAGES catalog（避免 schema 名外漏 — Codex 2nd-pass）。
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint|SQLITE_CONSTRAINT/i.test(msg)) {
      console.warn('[setMaster] UNIQUE collision (concurrent master change)', msg);
      throw new AppError('STALE_ENTRY');
    }
    throw err;
  }

  // round 5 fix: OCC version is trip_entries.entry_pois_version (integer counter).
  // We just bumped it in the batch — SELECT it back to return.
  const newVersion = await getEntryPoisVersion(db, entryId);
  return { version: newVersion, oldMasterPoiId };
}

/** Add alternate POI（sort_order = max + 1）。 */
export async function addAlternate(
  db: D1Database,
  entryId: number,
  poiId: number,
  expectedVersion?: string,
): Promise<{ sortOrder: number; version: string }> {
  // Parallel OCC version check + snapshot SELECTs — round 4 fix Codex F3 (alternates CRUD
  // shares OCC with setMaster so concurrent reorders/adds can't silently overwrite).
  // expectedVersion provided 時 4 SELECTs 並行 fetch + fail-fast 一個 RT 完成。
  const [versionRow, masterCount, dup, maxRow] = await Promise.all([
    expectedVersion !== undefined
      ? db
          .prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?')
          .bind(entryId)
          .first<{ v: number | null }>()
      : Promise.resolve(null),
    db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ c: number }>(),
    db
      .prepare('SELECT id FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, poiId)
      .first(),
    db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entryId)
      .first<{ max_order: number }>(),
  ]);

  // OCC fail-fast — stringify to match getEntryPoisVersion contract (string-typed API surface).
  if (expectedVersion !== undefined && String(versionRow?.v ?? 0) !== expectedVersion) {
    throw new AppError('STALE_ENTRY');
  }

  // At-least-one invariant: alternate 不能在沒 master 時加
  if (!masterCount || masterCount.c === 0) {
    throw new AppError('MISSING_MASTER', 'Entry must have a master POI before adding alternates');
  }
  if (dup) {
    throw new AppError('DUPLICATE_POI', `POI ${poiId} already exists in entry ${entryId}`);
  }

  const newSortOrder = (maxRow?.max_order ?? 0) + 1;
  const now = nowMs();

  // 同 setMaster CRITICAL #3：兩個並發 addAlternate 讀到同 max → 同 sort_order INSERT
  // → UNIQUE(entry_id, sort_order) collision；catch 後轉成 retryable STALE_ENTRY，
  // client 重抓 version 後再試。UNIQUE(entry_id, poi_id) 衝突也走同一 catch — 雖然語意
  // 上 DUPLICATE_POI 較精準，但 SQLite 的 SQLITE_CONSTRAINT 訊息不一定能分辨，統一收
  // 在 STALE_ENTRY 是 best-effort 處理（dup-check 已在 batch 前阻擋大部分情況）。
  // round 5 fix: bump entry_pois_version (dedicated OCC counter) instead of updated_at.
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(entryId, poiId, newSortOrder, now, now),
      db
        .prepare('UPDATE trip_entries SET entry_pois_version = entry_pois_version + 1 WHERE id = ?')
        .bind(entryId),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint|SQLITE_CONSTRAINT/i.test(msg)) {
      throw new AppError('STALE_ENTRY');
    }
    throw err;
  }

  const newVersion = await getEntryPoisVersion(db, entryId);
  return { sortOrder: newSortOrder, version: newVersion };
}

/** Remove alternate POI（不能 remove master — caller 應走 DELETE /entries/:id）。 */
export async function removeAlternate(
  db: D1Database,
  entryId: number,
  poiId: number,
  expectedVersion?: string,
): Promise<{ version: string }> {
  // Parallel OCC version check + row lookup — round 4 fix F3; expectedVersion provided 時
  // 2 SELECTs 並行 fetch + fail-fast 一個 RT 完成。
  const [versionRow, row] = await Promise.all([
    expectedVersion !== undefined
      ? db
          .prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?')
          .bind(entryId)
          .first<{ v: number | null }>()
      : Promise.resolve(null),
    db
      .prepare(
        'SELECT id, sort_order FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?',
      )
      .bind(entryId, poiId)
      .first<{ id: number; sort_order: number }>(),
  ]);

  // OCC fail-fast 在 row null check 之前 — stale token 應該回 409 而非 404，避免 client
  // 看到 POI_NOT_ALTERNATE 誤判 POI 已被別人 remove。
  if (expectedVersion !== undefined && String(versionRow?.v ?? 0) !== expectedVersion) {
    throw new AppError('STALE_ENTRY');
  }

  if (!row) {
    throw new AppError('POI_NOT_ALTERNATE', `POI ${poiId} not in entry ${entryId}`);
  }
  if (row.sort_order === 1) {
    throw new AppError(
      'DATA_VALIDATION',
      'Cannot remove master via alternates endpoint. Use DELETE /entries/:id to delete entire stop.',
    );
  }

  // Batch DELETE + entry_pois_version bump (round 5 fix — dedicated counter monotonic
  // by definition; removing the max-updated_at row no longer affects version).
  await db.batch([
    db.prepare('DELETE FROM trip_entry_pois WHERE id = ?').bind(row.id),
    db.prepare('UPDATE trip_entries SET entry_pois_version = entry_pois_version + 1 WHERE id = ?').bind(entryId),
  ]);

  const newVersion = await getEntryPoisVersion(db, entryId);
  return { version: newVersion };
}

/**
 * Reorder alternates。`orderedPoiIds` 是 alternates 的新順序（不含 master）。
 * 從 sort_order=2 起依序賦值。
 *
 * Validation:
 * - orderedPoiIds 必須完全等同當前 alternates set（不增不減）
 * - 不能含 master poi_id
 */
export async function reorderAlternates(
  db: D1Database,
  entryId: number,
  orderedPoiIds: number[],
  expectedVersion?: string,
): Promise<{ version: string }> {
  // Parallel OCC version check + alternates fetch — round 4 fix F3 (was missing entirely,
  // two concurrent reorders silently overwrote each other). expectedVersion provided 時
  // 2 SELECTs 並行 fetch + fail-fast 一個 RT 完成。
  const [versionRow, current] = await Promise.all([
    expectedVersion !== undefined
      ? db
          .prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?')
          .bind(entryId)
          .first<{ v: number | null }>()
      : Promise.resolve(null),
    getAlternates(db, entryId),
  ]);

  if (expectedVersion !== undefined && String(versionRow?.v ?? 0) !== expectedVersion) {
    throw new AppError('STALE_ENTRY');
  }

  const currentIds = new Set(current.map((a) => a.poiId));
  const orderedSet = new Set(orderedPoiIds);

  if (orderedPoiIds.length !== current.length || orderedPoiIds.some((id) => !currentIds.has(id))) {
    throw new AppError(
      'INVALID_ORDER',
      'orderedPoiIds must match current alternates exactly (no add/remove)',
    );
  }
  if (orderedSet.size !== orderedPoiIds.length) {
    throw new AppError('INVALID_ORDER', 'orderedPoiIds contains duplicates');
  }

  // 兩段式 UPDATE 避開 UNIQUE collision：
  // Phase 1: 全部 alternates 推到 temp range（max+100, max+101, ...）
  // Phase 2: 依 orderedPoiIds 重排到 2, 3, ...
  //
  // round 4 perf P7: max sort_order derived from getAlternates result (ASC ordered,
  // last element is the max alternate) — saves a redundant SELECT MAX round-trip.
  // Master holds sort_order=1, alternates start at 2 — so masterOrder+1 < altMaxOrder
  // always, and max(alternates) is enough since temp range only needs to exceed alts.
  const altMaxOrder = current.length > 0 ? current[current.length - 1]!.sortOrder : 1;
  const tempBase = altMaxOrder + 100;

  const now = nowMs();
  const phase1: D1PreparedStatement[] = current.map((a, i) =>
    db
      .prepare(`UPDATE trip_entry_pois SET sort_order = ?, updated_at = ? WHERE entry_id = ? AND poi_id = ?`)
      .bind(tempBase + i, now, entryId, a.poiId),
  );

  const phase2: D1PreparedStatement[] = orderedPoiIds.map((poiId, idx) =>
    db
      .prepare(`UPDATE trip_entry_pois SET sort_order = ?, updated_at = ? WHERE entry_id = ? AND poi_id = ?`)
      .bind(idx + 2, now, entryId, poiId),
  );

  // round 5 fix: bump entry_pois_version (dedicated counter)
  const bump = db.prepare('UPDATE trip_entries SET entry_pois_version = entry_pois_version + 1 WHERE id = ?').bind(entryId);

  await db.batch([...phase1, ...phase2, bump]);

  const newVersion = await getEntryPoisVersion(db, entryId);
  return { version: newVersion };
}

/**
 * 確保 trip_entry_pois 對 entry_id 有 sort_order=1 row（v2.27.0 multi-POI invariant）。
 * 給 entry-create 路徑（POST /entries / PUT /days/:num / copy）在 INSERT trip_entries
 * 之後立刻呼叫，避免「entry 建好後 addAlternate MISSING_MASTER」的 bug
 * （Codex pre-landing CRITICAL #2）。
 *
 * 行為：
 *   - 若 trip_entry_pois 已有 sort_order=1 且 poi_id 相同 → no-op
 *   - 若 trip_entry_pois 已有 sort_order=1 但 poi_id 不同 → UPDATE 改 poi_id（這是 master swap，
 *     正規路徑應走 setMaster() 含 segments 更新；此 helper 只供 entry-create 場景，假設沒
 *     existing master row，所以直接 UPDATE 也安全）
 *   - 若無 sort_order=1 row → INSERT
 *
 * round 7 fix: INSERT / naked UPDATE path 也 bump entry_pois_version 保持 monotonic
 * invariant — 即使 syncEntryMaster 主要在 entry-create 用，PUT /days/:num 帶 reorder
 * 場景下既有 entry 也會走 naked UPDATE path 而不 bump，讓 outstanding setMaster token
 * 誤判為 fresh（adversarial round 6 #1）。
 *
 * migration 0078: 可選 `note` 參數 —— entry-create 路徑（POST /entries、PUT /days name fallback）
 * 把 entry-level 備註寫進「新建 master」的 per-POI note。**只作用於 INSERT(new master) 分支**：
 *   - 既有呼叫端不傳 note（undefined）→ 行為完全不變（向後相容）。
 *   - 顯式傳 null → master.note 寫 NULL。
 *   - 傳字串 → master.note 寫該值。
 * no-op / asAlternate(swap) / naked-UPDATE 分支「不」碰 note —— 那些是既有 master 的搬移/置換，
 * note 應隨對應 POI 走，不該被 entry-create 的 note 蓋掉。
 *
 * @param db D1
 * @param entryId 已存在的 trip_entries.id
 * @param poiId 對應的 pois.id (NOT NULL)
 * @param note 可選；僅在新建 master（INSERT 分支）時寫入 master 的 trip_entry_pois.note。
 *             undefined → 不寫（維持現狀）；null / 字串 → 寫該值。
 */
export async function syncEntryMaster(
  db: D1Database,
  entryId: number,
  poiId: number,
  note?: string | null,
): Promise<void> {
  const now = nowMs();
  // INSERT OR REPLACE on UNIQUE(entry_id, sort_order) 會 swap 既有 sort_order=1 row
  // 但 UNIQUE(entry_id, poi_id) 可能讓「同 POI 已存在當 alternate」的場景失敗。
  // 安全做法：先 SELECT 既有 sort_order=1 → 不存在則 INSERT；存在 + 不同 POI 則需要
  // master↔alternate swap，路由到 setMaster (round 4 fix adv-C4 — naked UPDATE blew up
  // on UNIQUE(entry_id, poi_id) when new poiId was already an alternate of this entry).
  const [existing, asAlternate] = await Promise.all([
    db
      .prepare('SELECT id, poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ id: number; poi_id: number }>(),
    db
      .prepare('SELECT id FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ? AND sort_order > 1')
      .bind(entryId, poiId)
      .first<{ id: number }>(),
  ]);

  if (!existing) {
    // round 7 fix: bump entry_pois_version atomically with the INSERT so outstanding
    // OCC tokens become stale on master creation.
    // migration 0078: 帶 note 時一起寫進新 master 的 per-POI note（entry-create 路徑用）。
    await db.batch([
      db
        .prepare(
          `INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, added_at, updated_at, note)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .bind(entryId, poiId, now, now, note ?? null),
      db
        .prepare('UPDATE trip_entries SET entry_pois_version = entry_pois_version + 1 WHERE id = ?')
        .bind(entryId),
    ]);
    return;
  }

  if (existing.poi_id === poiId) {
    // poi_id 相同 → no-op
    return;
  }

  if (asAlternate) {
    // poiId 已是這個 entry 的 alternate → naked UPDATE 會撞 UNIQUE(entry_id, poi_id)。
    // 走 setMaster 做 master↔alternate swap，連帶 dual-write + segments stale 一起處理。
    // setMaster 內部已 bump entry_pois_version。
    await setMaster(db, entryId, poiId);
    return;
  }

  // existing master poi_id != poiId, and poiId is not yet an alternate → safe UPDATE
  // round 7 fix: bump entry_pois_version atomically with the UPDATE.
  await db.batch([
    db
      .prepare('UPDATE trip_entry_pois SET poi_id = ?, updated_at = ? WHERE id = ?')
      .bind(poiId, now, existing.id),
    db
      .prepare('UPDATE trip_entries SET entry_pois_version = entry_pois_version + 1 WHERE id = ?')
      .bind(entryId),
  ]);
}
