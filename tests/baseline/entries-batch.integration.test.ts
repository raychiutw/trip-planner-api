/**
 * Integration test — PATCH /api/trips/:id/entries/batch
 *
 * 同 Day reorder 多 entries 時使用單一 transaction batch update，避免 N+1
 * write；drag drop 後一次送 5 entries。
 *
 * Field naming：DB schema 與 endpoint 都使用 `sort_order`，對齊
 * PATCH /entries/:eid 既有 contract。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const OWNER = 'entries-batch-owner@test.com';
// 匿名的瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 handler 的 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
const tripIds: string[] = [];
/** 建立行程並記下 id，afterAll 清掉（共用 D1）。 */
const seed = async (opts: { id: string }) => {
  tripIds.push(opts.id);
  return seedTrip(db, { owner: OWNER, ...opts });
};
const batch = (updates: unknown, as: string | null = OWNER) =>
  api.request('PATCH', '/api/trips/s8-batch/entries/batch', {
    as: as ?? undefined,
    json: { updates },
    headers: as ? undefined : { Origin: BROWSER_ORIGIN },
  });

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: BROWSER_ORIGIN }) });
  await seed({ id: 's8-batch' });
  await seed({ id: 's8-batch-other' });
});

afterAll(async () => {
  // 共用 D1：只清自己建立的行程（days / entries 等子表走 FK cascade，permissions 要手動清）
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

describe('PATCH /api/trips/:id/entries/batch', () => {
  it('一次更新 5 entries 的 sort_order → 200，順序與 day_id 持久化', async () => {
    const dayId = await getDayId(db, 's8-batch', 1);
    const ids = await Promise.all([
      seedEntry(db, dayId, { sortOrder: 0 }),
      seedEntry(db, dayId, { sortOrder: 1 }),
      seedEntry(db, dayId, { sortOrder: 2 }),
      seedEntry(db, dayId, { sortOrder: 3 }),
      seedEntry(db, dayId, { sortOrder: 4 }),
    ]);
    // 模擬 drag E 到頭：reorder 為 E A B C D
    const reordered = [ids[4], ids[0], ids[1], ids[2], ids[3]];
    const updates = reordered.map((id, idx) => ({ id, sort_order: idx }));

    const resp = await batch(updates);
    expect(resp.status).toBe(200);

    const rows = await db.prepare('SELECT id, sort_order FROM trip_entries WHERE id IN (?, ?, ?, ?, ?) ORDER BY sort_order').bind(...reordered).all<{ id: number; sort_order: number }>();
    expect(rows.results.map((r) => r.id)).toEqual(reordered);
  });

  it('Cross-day move：同次 batch 更新 day_id + sort_order', async () => {
    const day1 = await getDayId(db, 's8-batch', 2);
    const day2 = await getDayId(db, 's8-batch', 3);
    const eid = await seedEntry(db, day1, { sortOrder: 0 });
    const updates = [{ id: eid, day_id: day2, sort_order: 99 }];

    const resp = await batch(updates);
    expect(resp.status).toBe(200);

    const row = await db.prepare('SELECT day_id, sort_order FROM trip_entries WHERE id = ?').bind(eid).first<{ day_id: number; sort_order: number }>();
    expect(row?.day_id).toBe(day2);
    expect(row?.sort_order).toBe(99);
  });

  it('未認證 → 401', async () => {
    expect((await batch([], null)).status).toBe(401);
  });

  it('無 trip 權限 → 403', async () => {
    expect((await batch([], 'entries-batch-stranger@test.com')).status).toBe(403);
  });

  it('updates 內有不屬於該 trip 的 entry → 404 atomically，原 entry 不被改', async () => {
    const dayId = await getDayId(db, 's8-batch', 1);
    const otherDayId = await getDayId(db, 's8-batch-other', 1);
    const myEntry = await seedEntry(db, dayId, { sortOrder: 50 });
    const otherEntry = await seedEntry(db, otherDayId, { sortOrder: 50 });

    const resp = await batch([
      { id: myEntry, sort_order: 999 },
      { id: otherEntry, sort_order: 999 },
    ]);
    expect(resp.status).toBe(404);
    // myEntry 不應被修改 — 整 batch atomic 失敗
    const row = await db.prepare('SELECT sort_order FROM trip_entries WHERE id = ?').bind(myEntry).first<{ sort_order: number }>();
    expect(row?.sort_order).toBe(50);
  });

  it('day_id 屬於別 trip → 403', async () => {
    const dayId = await getDayId(db, 's8-batch', 1);
    const otherDayId = await getDayId(db, 's8-batch-other', 1);
    const eid = await seedEntry(db, dayId, { sortOrder: 60 });

    expect((await batch([{ id: eid, day_id: otherDayId }])).status).toBe(403);
  });

  it('updates 為空 → 400', async () => {
    expect((await batch([])).status).toBe(400);
  });

  it('updates 缺 id → 400', async () => {
    expect((await batch([{ sort_order: 1 }])).status).toBe(400);
  });

  // v2.33.104 T-10: sort_order UNIQUE invariant validation + atomic rollback。
  // 之前 v2.33.97 補 (day_id, sort_order) UNIQUE 預檢，避免 SQLite UNIQUE 失敗
  // 落到中途留 partial state。
  describe('sort_order UNIQUE invariant (T-10)', () => {
    it('同 day_id + 同 sort_order 在同 batch 重複 → 400 atomic（無一被改）', async () => {
      const dayId = await getDayId(db, 's8-batch', 1);
      const e1 = await seedEntry(db, dayId, { sortOrder: 1000 });
      const e2 = await seedEntry(db, dayId, { sortOrder: 1001 });

      const resp = await batch([
        { id: e1, sort_order: 2000 },
        { id: e2, sort_order: 2000 }, // 同 day_id 重複
      ]);
      expect(resp.status).toBe(400);
      const data = await resp.json() as { error?: { message?: string } };
      expect(JSON.stringify(data)).toContain('重複');

      // atomic: 兩個 entry 都沒被改
      const r1 = await db.prepare('SELECT sort_order FROM trip_entries WHERE id = ?').bind(e1).first<{ sort_order: number }>();
      const r2 = await db.prepare('SELECT sort_order FROM trip_entries WHERE id = ?').bind(e2).first<{ sort_order: number }>();
      expect(r1?.sort_order).toBe(1000);
      expect(r2?.sort_order).toBe(1001);
    });

    it('不同 day_id 同 sort_order 允許（key 含 day_id）', async () => {
      const day1 = await getDayId(db, 's8-batch', 1);
      const day2 = await getDayId(db, 's8-batch', 2);
      const e1 = await seedEntry(db, day1, { sortOrder: 3000 });
      const e2 = await seedEntry(db, day2, { sortOrder: 3001 });

      const resp = await batch([
        { id: e1, day_id: day1, sort_order: 5000 },
        { id: e2, day_id: day2, sort_order: 5000 }, // 不同 day_id 同 sort_order OK
      ]);
      expect(resp.status).toBe(200);
    });
  });
});
