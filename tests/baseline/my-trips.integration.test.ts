/**
 * Integration test — GET /api/my-trips
 * 走 HTTP 邊界（tests/api/http.ts）；共用 D1，專屬 trip／email，結束時清掉。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

let db: D1Database;
let api: Api;
const ME = 'my-trips-me@test.com';
const T1 = 'trip-my-1-http';
const T2 = 'trip-my-2-http';
const TOTHER = 'trip-my-other-http';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: T1, owner: ME });
  await seedTrip(db, { id: T2, owner: ME });
  await seedTrip(db, { id: TOTHER, owner: 'my-trips-other@test.com' });
});

afterAll(async () => {
  await cleanupTrips(db, [T1, T2, TOTHER]);
  await disposeMiniflare();
});

describe('GET /api/my-trips', () => {
  it('member 看到自己的行程', async () => {
    const resp = await api.get('/api/my-trips', { as: ME });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(2);
    expect(data.every(t => t.tripId === T1 || t.tripId === T2)).toBe(true);
    expect(data.every(t => t.archivedAt === null)).toBe(true);
  });

  it('預設先列出最近更新的行程', async () => {
    await db.prepare("UPDATE trips SET updated_at = '2026-01-01 00:00:00' WHERE id = ?").bind(T1).run();
    await db.prepare("UPDATE trips SET updated_at = '2026-01-02 00:00:00' WHERE id = ?").bind(T2).run();
    const resp = await api.get('/api/my-trips', { as: ME });
    const data = await resp.json() as Array<{ tripId: string; updatedAt: string }>;
    expect(data.map((trip) => trip.tripId)).toEqual([T2, T1]);
    expect(data.map((trip) => trip.updatedAt)).toEqual(['2026-01-02 00:00:00', '2026-01-01 00:00:00']);
  });

  it('非 owner 不再看到所有行程（Phase 3：無全域 admin bypass）', async () => {
    // API tests 共用 D1；permissions.integration.test.ts 會替 admin@test.com 建行程。
    // 用專屬無權限身分驗證沒有 trip_permissions row 時不會看到別人的行程。
    const resp = await api.get('/api/my-trips', { as: 'no-trips-my-trips@example.invalid' });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(0);
  });

  it('受限 token（restrict_trip）只看自己那個 trip，不列舉 owner 其他 trip（v2.55.56 confused-deputy 偵察面）', async () => {
    // ME 擁有兩個行程，但受限到 T1 的 token 只該看到 T1。
    const resp = await api.get('/api/my-trips', { as: ME, restrictTrip: T1 });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data.length).toBe(1);
    expect(data[0]!.tripId).toBe(T1);
  });

  it('未認證 → 401（由 middleware 在 handler 之前攔截）', async () => {
    // 原本是「直接呼叫 handler 會 crash」；走 HTTP 邊界後可直接驗真實對外行為。
    const resp = await api.get('/api/my-trips');
    expect(resp.status).toBe(401);
  });
});
