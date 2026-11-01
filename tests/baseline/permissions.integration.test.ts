/**
 * Integration test — GET /api/permissions
 * 走 HTTP 邊界（tests/api/http.ts）：真實 bearer → middleware → handler。
 * 注意：POST/DELETE 會呼叫 Cloudflare Access API，這裡只測 D1 邏輯
 * （Access API 呼叫會因無效 token 而失敗，但 D1 邏輯部分可驗證）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

const TRIP = 'perm-int-trip';
const OWNER = 'perm-int-owner@test.com';
const URL_ = `https://test.com/api/permissions?tripId=${TRIP}`;
let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
});

afterAll(async () => {
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('GET /api/permissions', () => {
  it('owner 列出權限', async () => {
    const resp = await api.get(URL_, { as: OWNER });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.some(row => row.email === OWNER && row.role === 'owner')).toBe(true);
  });

  it('非 owner → 403', async () => {
    const resp = await api.get(URL_, { as: 'perm-int-user@test.com' });
    expect(resp.status).toBe(403);
  });

  it('受限 token（restrict_trip）→ 403，即使是 owner 且目標就是 scoped trip（v2.55.56 confused-deputy）', async () => {
    // owner 的 token 若被 downscope 成 restrict_trip，仍不可管理共編 —
    // 邀請成員是持久性提權，超出「只做內容編輯」的受限 agent 職權。
    const resp = await api.get(URL_, { as: OWNER, restrictTrip: TRIP });
    expect(resp.status).toBe(403);
  });

  it('未認證 → 401（middleware 在 handler 前攔截）', async () => {
    const resp = await api.get(URL_);
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });
});
