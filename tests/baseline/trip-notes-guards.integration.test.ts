/**
 * 補強測試：行程筆記的守衛分支（由 mutation 測試發現原測試未涵蓋）
 *
 *   - reorder：重複 id、非正整數 id、負的 sortOrder 都要 400 且資料不變
 *   - maintenance／exclusion 刪除：以另一個「自己也有寫入權限」的行程路徑操作
 *     他行程的列，必須 404 且資料不變（rowId 歸屬檢查，非僅靠寫入權限）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTripNotes } from './cleanup-trip-notes';

let db: D1Database;
let api: Api;
const tripA = 's18-notes-guard-a';
const tripB = 's18-notes-guard-b';
const owner = 'owner@s18-notes-guard.test';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedUser(db, owner);
  await seedTrip(db, { id: tripA, owner });
  await seedTrip(db, { id: tripB, owner });
});

afterAll(async () => {
  await cleanupTripNotes(db, ['s18-notes-guard-%'], ['%@s18-notes-guard.test']);
  await disposeMiniflare();
});

const req = (method: string, path: string, json?: unknown) => api.request(method, path, { as: owner, json });

async function createFlight(tripId: string, no: string): Promise<number> {
  const res = await req('POST', `/api/trips/${tripId}/notes/flights`, { airline: 'CI', flight_no: no });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

async function sortOrders(tripId: string): Promise<number[]> {
  const { results } = await db.prepare('SELECT sort_order FROM trip_flights WHERE trip_id = ? ORDER BY id').bind(tripId).all<{ sort_order: number }>();
  return (results ?? []).map((r) => r.sort_order);
}

describe('reorder 輸入驗證', () => {
  it('重複 id → 400 且排序不變', async () => {
    const a = await createFlight(tripA, 'G1');
    const b = await createFlight(tripA, 'G2');
    const before = await sortOrders(tripA);
    const res = await req('PATCH', `/api/trips/${tripA}/notes/flights/reorder`, {
      items: [{ id: a, sortOrder: 5 }, { id: a, sortOrder: 6 }, { id: b, sortOrder: 7 }],
    });
    expect(res.status).toBe(400);
    expect(await sortOrders(tripA)).toEqual(before);
  });

  it('id 為 0 或負數 → 400', async () => {
    for (const id of [0, -3]) {
      const res = await req('PATCH', `/api/trips/${tripA}/notes/flights/reorder`, { items: [{ id, sortOrder: 1 }] });
      expect(res.status, `id=${id}`).toBe(400);
    }
  });

  it('sortOrder 為負數 → 400 且排序不變', async () => {
    const a = await createFlight(tripA, 'G3');
    const before = await sortOrders(tripA);
    const res = await req('PATCH', `/api/trips/${tripA}/notes/flights/reorder`, { items: [{ id: a, sortOrder: -1 }] });
    expect(res.status).toBe(400);
    expect(await sortOrders(tripA)).toEqual(before);
  });
});

describe('跨行程 rowId 歸屬（呼叫者對兩個行程都有寫入權限）', () => {
  it('maintenance：用 tripB 路徑改 tripA 的列 → 404 且 managed_by 不變', async () => {
    const created = await req('POST', `/api/trips/${tripA}/notes/pretrip`, { title: '跨行程維護', body: 'x' });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: number; version: number };
    const before = await db.prepare('SELECT managed_by, version FROM trip_pretrip_notes WHERE id = ?').bind(row.id).first<{ managed_by: string; version: number }>();
    const res = await req('PATCH', `/api/trips/${tripB}/notes/pretrip/${row.id}/maintenance`, { managedBy: 'ai', expectedVersion: row.version });
    expect(res.status).toBe(404);
    const after = await db.prepare('SELECT managed_by, version FROM trip_pretrip_notes WHERE id = ?').bind(row.id).first<{ managed_by: string; version: number }>();
    expect(after).toEqual(before);
  });

  it('exclusion 刪除：用 tripB 路徑刪 tripA 的排除項 → 404 且資料仍在', async () => {
    const ex = await db.prepare(
      `INSERT INTO trip_note_ai_exclusions (trip_id, doc_type, semantic_key, label)
       VALUES (?, 'emergency', 'guard-key', '守衛測試') RETURNING id`,
    ).bind(tripA).first<{ id: number }>();
    const res = await req('DELETE', `/api/trips/${tripB}/notes/emergency/exclusions/${ex!.id}`);
    expect(res.status).toBe(404);
    const still = await db.prepare('SELECT COUNT(*) AS n FROM trip_note_ai_exclusions WHERE id = ?').bind(ex!.id).first<{ n: number }>();
    expect(still!.n).toBe(1);
  });
});
