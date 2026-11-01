/**
 * Integration test — POST /api/trips/:id/audit/:aid/rollback
 * 走 HTTP 邊界（tests/api/http.ts），以真實 bearer token 認證；共用 D1 用 s16- 專屬 id／email。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

const TRIP = 's16-rb-trip';
const OWNER = 's16-rb-owner@test.com';
const STRANGER = 's16-rb-stranger@test.com';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
});

afterAll(async () => {
  await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP], ['s16-rb-%']);
  await disposeMiniflare();
});

// 行為變更：新 api 沒有 CSRF gate，匿名寫入直接 401（不必帶 Origin）

function rollback(auditId: number | string, as: string | null = OWNER) {
  return api.request('POST', `/api/trips/${TRIP}/audit/${auditId}/rollback`,
    as ? { as } : {});
}

describe('POST /api/trips/:id/audit/:aid/rollback', () => {
  it('rollback update → 還原舊值', async () => {
    const dayId = await getDayId(db, TRIP, 1);
    const entryId = await seedEntry(db, dayId);

    // 模擬 update audit log（description 從 Original → Changed）
    await db.prepare(
      "INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, diff_json) VALUES (?, 'trip_entries', ?, 'update', 's16-rb-owner@test.com', ?)"
    ).bind(TRIP, entryId, JSON.stringify({ description: { old: 'Original', new: 'Changed' } })).run();

    // 先改掉 description
    await db.prepare('UPDATE trip_entries SET description = ? WHERE id = ?').bind('Changed', entryId).run();

    const auditRow = await db.prepare(
      'SELECT id FROM audit_log WHERE trip_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(TRIP).first<{ id: number }>();

    const resp = await rollback(auditRow!.id);
    expect(resp.status).toBe(200);

    // 驗證已還原
    const entry = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first();
    expect((entry as Record<string, unknown>).description).toBe('Original');
  });

  it('rollback insert → 刪除記錄', async () => {
    const dayId = await getDayId(db, TRIP, 2);
    const entryId = await seedEntry(db, dayId);

    await db.prepare(
      "INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by) VALUES (?, 'trip_entries', ?, 'insert', 's16-rb-owner@test.com')"
    ).bind(TRIP, entryId).run();

    const auditRow = await db.prepare(
      'SELECT id FROM audit_log WHERE trip_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(TRIP).first<{ id: number }>();

    const resp = await rollback(auditRow!.id);
    expect(resp.status).toBe(200);

    const entry = await db.prepare('SELECT * FROM trip_entries WHERE id = ?').bind(entryId).first();
    expect(entry).toBeNull();
  });

  it('rollback update on DROPPED column (trip_entries.note) → 400 乾淨拒絕，不 500', async () => {
    // migration 0078: trip_entries.note 已 DROP。針對 cutover 前產生的、diff 指向 note
    // 的歷史 update audit，rollback 必須在 column whitelist 階段乾淨拒絕（400 DATA_VALIDATION
    // 「Invalid column(s)」），而非通過 whitelist 後執行 `UPDATE trip_entries SET note=?`
    // 撞 "no such column: note" 變成 opaque 500。對齊本 handler header 對 dropped-column
    // rollback 的承諾（與既有 time/poi_id/travel_* cutover 一致）。
    const dayId = await getDayId(db, TRIP, 3);
    const entryId = await seedEntry(db, dayId);

    await db.prepare(
      "INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, diff_json) VALUES (?, 'trip_entries', ?, 'update', 's16-rb-owner@test.com', ?)"
    ).bind(TRIP, entryId, JSON.stringify({ note: { old: '舊備註', new: '新備註' } })).run();

    const auditRow = await db.prepare(
      'SELECT id FROM audit_log WHERE trip_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(TRIP).first<{ id: number }>();

    const resp = await rollback(auditRow!.id);
    expect(resp.status).toBe(400);
    const bodyObj = await resp.json() as { error?: { code?: string; message?: string; detail?: string } };
    expect(bodyObj.error?.code).toBe('DATA_VALIDATION');
    // detail 帶具體欄位名（handler: `Invalid column(s) in diff: note`）
    expect(bodyObj.error?.detail ?? '').toContain('note');
  });

  it('pois snapshot 帶 photos（非 whitelist 欄位）→ 400 乾淨拒絕，不 500', async () => {
    // photos 已從 TABLE_COLUMNS.pois 移除（欄位本身由 migration 0086 於後續 PR DROP）。
    // pois delete-audit 的 snapshot 由 `SELECT *` 產生、必帶 photos key → 必須在
    // whitelist 階段乾淨拒絕（400 DATA_VALIDATION「Invalid column(s) in snapshot」），
    // 而非通過後執行 `INSERT INTO pois (..., photos, ...)` —— 0086 套用後那會撞
    // "no such column: photos" 變 opaque 500。同 0062 / 0078 慣例（該慣例包含這個鎖，
    // 不只是 handler 註解）。
    //
    // 刻意 schema-independent：whitelist 在任何 SQL 碰到 pois 之前就短路，所以本測試
    // 在「欄位還在」(本 PR) 與「欄位已 DROP」(0086 後) 兩種 schema 下都綠 —— 那正是這道
    // 防線的價值所在。它鎖的是「photos 不在 whitelist」，不是「欄位已消失」；
    // 後者由 tests/unit/migration-0086-drop-pois-photos.test.ts 以 PRAGMA 驗。
    //
    // 註：這也是本檔第一個覆蓋 snapshot 分支（rollback.ts 的 invalidSnapshotCols）的測試；
    // 既有的 0078 測試走的是 diff/update 分支。
    const poi = await db.prepare(
      "INSERT INTO pois (type, name) VALUES ('attraction', 's16-rb-legacy-snap') RETURNING id"
    ).first<{ id: number }>();
    await db.prepare('DELETE FROM pois WHERE id = ?').bind(poi!.id).run();

    await db.prepare(
      "INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, snapshot) VALUES (?, 'pois', ?, 'delete', 's16-rb-owner@test.com', ?)"
    ).bind(TRIP, poi!.id, JSON.stringify({
      id: poi!.id, type: 'attraction', name: 's16-rb-legacy-snap', photos: null, price: null,
    })).run();

    const auditRow = await db.prepare(
      'SELECT id FROM audit_log WHERE trip_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(TRIP).first<{ id: number }>();

    const resp = await rollback(auditRow!.id);
    expect(resp.status).toBe(400);
    const bodyObj = await resp.json() as { error?: { code?: string; detail?: string } };
    expect(bodyObj.error?.code).toBe('DATA_VALIDATION');
    expect(bodyObj.error?.detail ?? '').toContain('photos');
  });

  it('pois diff 指向 photos（非 whitelist 欄位）→ 400', async () => {
    const poi = await db.prepare(
      "INSERT INTO pois (type, name) VALUES ('attraction', 's16-rb-diff-photos') RETURNING id"
    ).first<{ id: number }>();
    await db.prepare(
      "INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, diff_json) VALUES (?, 'pois', ?, 'update', 's16-rb-owner@test.com', ?)"
    ).bind(TRIP, poi!.id, JSON.stringify({ photos: { old: '[]', new: null } })).run();

    const auditRow = await db.prepare(
      'SELECT id FROM audit_log WHERE trip_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(TRIP).first<{ id: number }>();

    const resp = await rollback(auditRow!.id);
    expect(resp.status).toBe(400);
    const bodyObj = await resp.json() as { error?: { detail?: string } };
    expect(bodyObj.error?.detail ?? '').toContain('photos');
  });

  // 以下為 mutation 驗證發現的缺口：回應內容、回滾本身的稽核、delete 還原與衝突、跨行程隔離
  async function insertAudit(fields: { table: string; recordId: number | null; action: string; diff?: unknown; snapshot?: unknown; tripId?: string }) {
    const row = await db.prepare(
      'INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, diff_json, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(
      fields.tripId ?? TRIP, fields.table, fields.recordId, fields.action, OWNER,
      fields.diff === undefined ? null : JSON.stringify(fields.diff),
      fields.snapshot === undefined ? null : JSON.stringify(fields.snapshot),
    ).first<{ id: number }>();
    return row!.id;
  }

  async function rollbackAuditRows(originalAuditId: number) {
    const rs = await db.prepare(
      'SELECT action, table_name AS tableName, record_id AS recordId, changed_by AS changedBy, diff_json AS diffJson FROM audit_log WHERE trip_id = ? AND diff_json LIKE ? ORDER BY id'
    ).bind(TRIP, `%"rollback_of":${originalAuditId}%`).all<{ action: string; tableName: string; recordId: number; changedBy: string; diffJson: string }>();
    return rs.results;
  }

  it('rollback update 回應 rolledBack=update->revert，並寫一筆以呼叫者為 changed_by 的 update 稽核', async () => {
    const entryId = await seedEntry(db, await getDayId(db, TRIP, 1));
    await db.prepare('UPDATE trip_entries SET description = ? WHERE id = ?').bind('Changed2', entryId).run();
    const auditId = await insertAudit({ table: 'trip_entries', recordId: entryId, action: 'update', diff: { description: { old: 'Orig2', new: 'Changed2' } } });
    const resp = await rollback(auditId);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, rolledBack: 'update->revert' });
    const audits = await rollbackAuditRows(auditId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'update', tableName: 'trip_entries', recordId: entryId, changedBy: OWNER });
    expect(JSON.parse(audits[0]!.diffJson)).toMatchObject({ reverted: { description: 'Orig2' } });
  });

  it('rollback insert 回應 rolledBack=insert->delete，並寫一筆帶被刪列 snapshot 的 delete 稽核', async () => {
    const entryId = await seedEntry(db, await getDayId(db, TRIP, 2));
    const auditId = await insertAudit({ table: 'trip_entries', recordId: entryId, action: 'insert' });
    const resp = await rollback(auditId);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, rolledBack: 'insert->delete' });
    const audits = await rollbackAuditRows(auditId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'delete', tableName: 'trip_entries', recordId: entryId, changedBy: OWNER });
    const snap = await db.prepare('SELECT snapshot FROM audit_log WHERE trip_id = ? AND diff_json LIKE ?')
      .bind(TRIP, `%"rollback_of":${auditId}%`).first<{ snapshot: string }>();
    expect(JSON.parse(snap!.snapshot)).toMatchObject({ id: entryId });
  });

  it('rollback delete → 用 snapshot 把列還原回來，並寫 insert 稽核', async () => {
    const dayId = await getDayId(db, TRIP, 3);
    const entryId = await seedEntry(db, dayId);
    await db.prepare('UPDATE trip_entries SET description = ? WHERE id = ?').bind('被刪掉的', entryId).run();
    const snapshot = { id: entryId, day_id: dayId, sort_order: 1, start_time: '10:00', description: '被刪掉的' };
    await db.prepare('DELETE FROM trip_entries WHERE id = ?').bind(entryId).run();
    const auditId = await insertAudit({ table: 'trip_entries', recordId: entryId, action: 'delete', snapshot });
    const resp = await rollback(auditId);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, rolledBack: 'delete->re-insert' });
    const restored = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first<{ description: string }>();
    expect(restored?.description).toBe('被刪掉的');
    const audits = await rollbackAuditRows(auditId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'insert', tableName: 'trip_entries', recordId: entryId, changedBy: OWNER });
  });

  it('rollback delete 但該 ID 已有新資料 → 409，不覆蓋既有資料', async () => {
    const dayId = await getDayId(db, TRIP, 3);
    const entryId = await seedEntry(db, dayId);
    await db.prepare('UPDATE trip_entries SET description = ? WHERE id = ?').bind('現存資料', entryId).run();
    const snapshot = { id: entryId, day_id: dayId, sort_order: 9, description: '舊快照' };
    const auditId = await insertAudit({ table: 'trip_entries', recordId: entryId, action: 'delete', snapshot });
    const resp = await rollback(auditId);
    expect(resp.status).toBe(409);
    const row = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first<{ description: string }>();
    expect(row?.description).toBe('現存資料');
    expect(await rollbackAuditRows(auditId)).toHaveLength(0);
  });

  it('rollback update 但目標列已不存在 → 404，且不寫回滾稽核', async () => {
    const auditId = await insertAudit({ table: 'trip_entries', recordId: 987654321, action: 'update', diff: { description: { old: 'a', new: 'b' } } });
    const resp = await rollback(auditId);
    expect(resp.status).toBe(404);
    expect(await rollbackAuditRows(auditId)).toHaveLength(0);
  });

  it('audit 屬於別的行程 → 404（不能用 A 行程的 owner 身分回滾 B 行程的 audit）', async () => {
    const OTHER = 's16-rb-other-trip';
    await seedTrip(db, { id: OTHER, owner: OWNER, days: 1 });
    try {
      const entryId = await seedEntry(db, await getDayId(db, OTHER, 1));
      await db.prepare('UPDATE trip_entries SET description = ? WHERE id = ?').bind('Changed3', entryId).run();
      const auditId = await insertAudit({ tripId: OTHER, table: 'trip_entries', recordId: entryId, action: 'update', diff: { description: { old: 'Orig3', new: 'Changed3' } } });
      expect((await rollback(auditId)).status).toBe(404);
      const row = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first<{ description: string }>();
      expect(row?.description).toBe('Changed3');
    } finally {
      await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(OTHER).run();
      await cleanupTrips(db, [OTHER]);
    }
  });

  it('非 owner（無 trip 寫權限）→ 403', async () => {
    expect((await rollback(1, STRANGER)).status).toBe(403);
  });

  it('未認證 → 401', async () => {
    expect((await rollback(1, null)).status).toBe(401);
  });

  it('不存在的 audit → 404', async () => {
    expect((await rollback(99999)).status).toBe(404); // owner（D4：rollback 改 owner gate）
  });
});
