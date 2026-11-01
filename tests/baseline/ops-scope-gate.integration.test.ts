/**
 * ops-scope-gate — 移除全域 admin 授權回歸鎖（Phase 1 建立，Phase 3 收緊）
 *
 * 走 HTTP 邊界：真實 bearer（服務 token 的 user_id 為 null；使用者 token 綁 user）→ middleware →
 * handler。原本直接呼叫 hasOpsScope / requireScope，改成打真正用到它們的 /api/admin/* 維運端點：
 *   ops:maps → GET  /api/admin/maps-settings
 *   ops:poi  → GET  /api/admin/backfill-status
 *   ops:cache→ POST /api/admin/cache-cleanup
 *
 * 驗證：
 *  - hasOpsScope / requireScope：只有 service token 帶對應 ops scope 才過；
 *    user-session 即使自帶 scopes 也不過（無偽造路徑）；Phase 3 已移除舊 admin
 *    scope 雙接受 — 只帶 admin scope 不再被當維運身份。
 *  - F1：master POI 寫入（PATCH/DELETE/enrich）改 ops:poi gate — service token
 *    帶 ops:poi 可不帶 tripId 直接改；無 ops:poi 的 token / 一般 user 走 owner 分支。
 *  - D4：audit 歷史改 per-trip owner gate（hasWritePermission）— owner 可看，
 *    陌生人 / service token 擋。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceTokenFor } from './service-token';
import { cleanupTrips } from './cleanup-trips';

const BASE = 'https://x.com';
let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(async () => {
  await db.prepare("DELETE FROM audit_log WHERE table_name = 'pois' AND changed_by = 'service:cli'").run();
  await cleanupTrips(db, ['ops-gate-%'], ['ops-gate-%']);
  await disposeMiniflare();
});

const svc = (scopes: string[], clientId = 'cli') => serviceTokenFor(db, { clientId, scopes });
const mapsSettings = (bearer: string) => api.get(`${BASE}/api/admin/maps-settings`, { bearer });
const backfillStatus = (bearer: string) => api.get(`${BASE}/api/admin/backfill-status`, { bearer });

describe('hasOpsScope (Phase 1 ops-scope gate)', () => {
  it('service token with matching ops scope → true; non-matching → false', async () => {
    const token = await svc(['ops:maps']);
    expect((await mapsSettings(token)).status).toBe(200);
    expect((await backfillStatus(token)).status).toBe(403); // ops:poi 不是它的
  });

  it('legacy admin scope 不再雙接受 → false for all ops (Phase 3 已移除過渡)', async () => {
    // Phase 1 過渡期 admin scope 雙接受任何 ops；Phase 3 移除 `|| scopes.includes('admin')`，
    // 舊 token 若只帶 admin scope 不再被當維運身份 — 必須重新 provision 細粒度 ops scope。
    const token = await svc(['admin']);
    expect((await mapsSettings(token)).status).toBe(403);
    expect((await backfillStatus(token)).status).toBe(403);
    const cache = await api.request('POST', `${BASE}/api/admin/cache-cleanup`, { bearer: token });
    expect(cache.status).toBe(403);
  });

  it('user session never passes even with scopes present (no forge)', async () => {
    // 使用者 token（綁 user_id）即使 scopes 含 ops:maps，也不是服務 token
    const res = await api.get(`${BASE}/api/admin/maps-settings`, { as: 'ops-gate-user@test.com', scopes: ['ops:maps'] });
    expect(res.status).toBe(403);
  });

  it('service token without scopes → false; null auth → false', async () => {
    expect((await mapsSettings(await svc([]))).status).toBe(403);
    // 匿名（沒有 auth）
    expect((await api.get(`${BASE}/api/admin/maps-settings`)).status).toBe(401);
  });
});

describe('requireScope', () => {
  it('returns auth when service token has the ops scope', async () => {
    const token = await svc(['ops:cache']);
    const res = await api.request('POST', `${BASE}/api/admin/cache-cleanup`, { bearer: token });
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { deleted: number }).deleted).toBe('number');
  });

  it('throws when scope missing or caller is a user session', async () => {
    expect((await backfillStatus(await svc(['ops:maps']))).status).toBe(403);
    const user = await api.get(`${BASE}/api/admin/maps-settings`, { as: 'ops-gate-user@test.com' });
    expect(user.status).toBe(403);
  });
});
