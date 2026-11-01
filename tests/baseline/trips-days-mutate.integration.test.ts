/**
 * Integration test — v2.33.0 POST /api/trips/:id/days + DELETE /api/trips/:id/days/:num
 *
 * 涵蓋：
 * - POST append: new day_num = max+1, date = max+1d
 * - POST prepend: 所有 day_num+1, INSERT day_num=1 + date = min-1d
 * - DELETE middle: cascade entries + 後續 day_num/date 上移
 * - DELETE 最後一天禁止
 * - 無權限 → PERM_DENIED
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const OWNER = 'mutate-owner@test.com';
// 匿名的瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 handler 的 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
const tripIds: string[] = [];
/** 建立行程並記下 id，afterAll 清掉（共用 D1）。 */
const seed = async (opts: { id: string; days?: number; owner?: string }) => {
  tripIds.push(opts.id);
  return seedTrip(db, { owner: OWNER, ...opts });
};

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: BROWSER_ORIGIN }) });
});

afterAll(async () => {
  // 共用 D1：只清自己建立的行程與測試用 trigger（days / entries 等子表走 FK cascade，permissions 要手動清）
  await db.prepare('DROP TRIGGER IF EXISTS reject_day_renumber').run();
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

describe('POST /api/trips/:id/days — append (position=end)', () => {
  it('append 新天，day_num 接續最大值，date 順延 1 天', async () => {
    await seed({ id: 'append-trip', days: 3 });
    // seedTrip 預設 date '2026-04-01', '2026-04-02', '2026-04-03'

    const resp = await api.request('POST', '/api/trips/append-trip/days', { as: 'mutate-owner@test.com', json: { position: 'end' } });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { day: { dayNum: number; date: string; dayOfWeek: string } };
    expect(body.day.dayNum).toBe(4);
    expect(body.day.date).toBe('2026-04-04');
    expect(body.day.dayOfWeek).toBe('六'); // 2026-04-04 是週六

    // DB 確認共 4 天
    const { results } = await db
      .prepare('SELECT day_num, date FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC')
      .bind('append-trip')
      .all();
    expect(results).toHaveLength(4);
  });
});

describe('POST /api/trips/:id/days — prepend (position=start)', () => {
  it('prepend 新天，現有 day_num 全 +1，新 day_num=1 + date 提前 1 天', async () => {
    await seed({ id: 'prepend-trip', days: 3 });

    const resp = await api.request('POST', '/api/trips/prepend-trip/days', { as: 'mutate-owner@test.com', json: { position: 'start' } });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { day: { dayNum: number; date: string } };
    expect(body.day.dayNum).toBe(1);
    expect(body.day.date).toBe('2026-03-31'); // 2026-04-01 前一天

    // DB 確認 4 天：day_num 1-4
    const { results } = await db
      .prepare('SELECT day_num, date FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC')
      .bind('prepend-trip')
      .all() as { results: Array<{ day_num: number; date: string }> };
    expect(results).toHaveLength(4);
    expect(results[0]!.day_num).toBe(1);
    expect(results[0]!.date).toBe('2026-03-31');
    expect(results[1]!.day_num).toBe(2);
    expect(results[1]!.date).toBe('2026-04-01'); // 原 day 1 變 day 2
  });
});

describe('POST /api/trips/:id/days — insert (position=insert, v2.33.7 fill gap)', () => {
  it('insert middle date → 找對應 day_num，後續 days day_num +1', async () => {
    await seed({ id: 'insert-trip', days: 3 });
    // Original: Day 1=4/1, Day 2=4/2, Day 3=4/3
    // Delete Day 2 (mid) 留 gap 4/2 → 剩 Day 1=4/1, Day 2=4/3 (renumbered)
    await api.request('DELETE', '/api/trips/insert-trip/days/2', { as: OWNER });

    // Now insert 4/2 back
    const resp = await api.request('POST', '/api/trips/insert-trip/days', { as: 'mutate-owner@test.com', json: {
        position: 'insert',
        date: '2026-04-02',
      } });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { day: { dayNum: number; date: string; dayOfWeek: string } };
    expect(body.day.date).toBe('2026-04-02');
    expect(body.day.dayNum).toBe(2);

    // DB 確認 3 天 day_num 1-3 contiguous dates
    const { results } = await db
      .prepare('SELECT day_num, date FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC')
      .bind('insert-trip')
      .all() as { results: Array<{ day_num: number; date: string }> };
    expect(results.map((r) => r.day_num)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.date)).toEqual(['2026-04-01', '2026-04-02', '2026-04-03']);
  });

  it('insert date 已存在 → 400', async () => {
    await seed({ id: 'insert-dup', days: 3 });
    const resp = await api.request('POST', '/api/trips/insert-dup/days', { as: 'mutate-owner@test.com', json: {
        position: 'insert',
        date: '2026-04-02', // 已存在
      } });
    expect(resp.status).toBe(400);
  });

  it('insert without date → 400', async () => {
    await seed({ id: 'insert-nodate', days: 1 });
    const resp = await api.request('POST', '/api/trips/insert-nodate/days', { as: 'mutate-owner@test.com', json: {
        position: 'insert',
      } });
    expect(resp.status).toBe(400);
  });
});

describe('POST /api/trips/:id/days — validation', () => {
  it('body 沒 position → 400', async () => {
    await seed({ id: 'val-trip', days: 1 });
    const resp = await api.request('POST', '/api/trips/val-trip/days', { as: 'mutate-owner@test.com', json: {} });
    expect(resp.status).toBe(400);
  });

  it('未登入 → 401', async () => {
    await seed({ id: 'auth-trip', days: 1 });
    const resp = await api.request('POST', '/api/trips/auth-trip/days', { headers: { Origin: BROWSER_ORIGIN }, json: { position: 'end' } });
    expect(resp.status).toBe(401);
  });

  it('非 owner → 403', async () => {
    await seed({ id: 'perm-trip', days: 1, owner: 'owner@test.com' });
    const resp = await api.request('POST', '/api/trips/perm-trip/days', { as: 'other@test.com', json: { position: 'end' } });
    expect(resp.status).toBe(403);
  });
});

describe('DELETE /api/trips/:id/days/:num — middle day cascade (v2.33.1: preserve dates)', () => {
  it('後續編號寫入失敗時刪除及 entries 一起回滾', async () => {
    await seed({ id: 'del-rollback', days: 3 });
    const d2Id = await getDayId(db, 'del-rollback', 2);
    await seedEntry(db, d2Id, { sortOrder: 0 });
    await db.prepare(`CREATE TRIGGER reject_day_renumber BEFORE UPDATE OF day_num ON trip_days
      WHEN NEW.trip_id = 'del-rollback' BEGIN SELECT RAISE(FAIL, 'blocked renumber'); END`).run();
    // 走 middleware 後，非預期的 DB 錯誤是 500 回應（不是往外拋例外）
    const resp = await api.request('DELETE', '/api/trips/del-rollback/days/2', { as: OWNER });
    expect(resp.status).toBe(500);
    const { results } = await db.prepare('SELECT day_num FROM trip_days WHERE trip_id = ? ORDER BY day_num')
      .bind('del-rollback').all<{ day_num: number }>();
    expect(results.map((day) => day.day_num)).toEqual([1, 2, 3]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE day_id = ?').bind(d2Id).first<{ n: number }>())?.n).toBe(1);
  });
  it('刪除中間天，cascade entries + 後續 day_num 上移；dates 保留（會留 gap）', async () => {
    await seed({ id: 'del-mid', days: 5 });
    const d3Id = await getDayId(db, 'del-mid', 3);
    await seedEntry(db, d3Id, { sortOrder: 0 });
    await seedEntry(db, d3Id, { sortOrder: 1 });

    const resp = await api.request('DELETE', '/api/trips/del-mid/days/3', { as: OWNER });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; removedEntryCount: number };
    expect(body.ok).toBe(true);
    expect(body.removedEntryCount).toBe(2);

    // v2.33.1: 剩 4 天，day_num 1-4，dates 保留（Day 3=5/3 跳過，Day 3 變 5/4 原值）。
    // 違反 contiguous 但保 user 意圖：「Day 3 那天我刪掉了，不要影響其他天的日期」
    const { results } = await db
      .prepare('SELECT day_num, date FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC')
      .bind('del-mid')
      .all() as { results: Array<{ day_num: number; date: string }> };
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.day_num)).toEqual([1, 2, 3, 4]);
    // dates 不再 contiguous — Day 3 (was 4/3) 已刪，原 Day 4 (4/4) → Day 3，date 保留 4/4
    expect(results.map((r) => r.date)).toEqual(['2026-04-01', '2026-04-02', '2026-04-04', '2026-04-05']);
    const entryRows = await db.prepare('SELECT id FROM trip_entries WHERE day_id = ?').bind(d3Id).all();
    expect(entryRows.results).toHaveLength(0);
  });

  it('刪除第一天（prepend / delete-first 對稱）— 剩餘 dates 保留', async () => {
    await seed({ id: 'del-first', days: 3 });
    // Original: Day 1=4/1, Day 2=4/2, Day 3=4/3
    const resp = await api.request('DELETE', '/api/trips/del-first/days/1', { as: OWNER });
    expect(resp.status).toBe(200);
    const { results } = await db
      .prepare('SELECT day_num, date FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC')
      .bind('del-first')
      .all() as { results: Array<{ day_num: number; date: string }> };
    expect(results.map((r) => r.day_num)).toEqual([1, 2]);
    expect(results.map((r) => r.date)).toEqual(['2026-04-02', '2026-04-03']);
  });
});

describe('DELETE /api/trips/:id/days/:num — last-day guard', () => {
  it('行程只剩 1 天時禁止刪除', async () => {
    await seed({ id: 'last-day', days: 1 });
    const resp = await api.request('DELETE', '/api/trips/last-day/days/1', { as: OWNER });
    expect(resp.status).toBe(400);
  });

  it('刪除不存在的 day → 404', async () => {
    await seed({ id: 'del-404', days: 3 });
    const resp = await api.request('DELETE', '/api/trips/del-404/days/99', { as: OWNER });
    expect(resp.status).toBe(404);
  });

  it('非 owner → 403', async () => {
    await seed({ id: 'del-perm', days: 3, owner: 'owner@test.com' });
    const resp = await api.request('DELETE', '/api/trips/del-perm/days/2', { as: 'other@test.com' });
    expect(resp.status).toBe(403);
  });
});
