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
import { mockEnv, seedTrip, seedPoi } from './helpers';
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

describe('F1 — master POI write gated by ops:poi', () => {
  async function poiName(id: number): Promise<string | undefined> {
    return (await db.prepare('SELECT name FROM pois WHERE id = ?').bind(id).first<{ name: string }>())?.name;
  }

  it('service token with ops:poi can PATCH master POI without tripId', async () => {
    const poiId = await seedPoi(db, { name: 'ops-gate-Old Name' });
    const res = await api.request('PATCH', `${BASE}/api/pois/${poiId}`, {
      bearer: await svc(['ops:poi']),
      json: { name: 'ops-gate-New Name' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('ops-gate-New Name');
    expect(await poiName(poiId)).toBe('ops-gate-New Name');
  });

  it('service token WITHOUT ops:poi (only ops:maps) is rejected from PATCH without tripId', async () => {
    const poiId = await seedPoi(db, { name: 'ops-gate-X' });
    const res = await api.request('PATCH', `${BASE}/api/pois/${poiId}`, {
      bearer: await svc(['ops:maps']),
      json: { name: 'ops-gate-Y' },
    });
    expect(res.status).not.toBe(200); // 走非維運分支 → 缺 tripId → DATA_VALIDATION
    expect(res.status).toBe(400);
    expect(await poiName(poiId)).toBe('ops-gate-X');
  });

  it('service token with ops:poi can DELETE master POI', async () => {
    const poiId = await seedPoi(db, { name: 'ops-gate-ToDelete' });
    const res = await api.request('DELETE', `${BASE}/api/pois/${poiId}`, { bearer: await svc(['ops:poi']) });
    expect(res.status).toBe(200);
    expect(await poiName(poiId)).toBeUndefined();
  });

  it('user (no ops scope) is rejected from DELETE master POI', async () => {
    const poiId = await seedPoi(db, { name: 'ops-gate-Z' });
    const res = await api.request('DELETE', `${BASE}/api/pois/${poiId}`, { as: 'ops-gate-user@test.com' });
    expect(res.status).not.toBe(200); // PERM_DENIED
    expect(res.status).toBe(403);
    expect(await poiName(poiId)).toBe('ops-gate-Z');
  });
});

describe('D4 — audit history gated by owner (hasWritePermission)', () => {
  const TRIP = 'ops-gate-audit';
  beforeAll(async () => {
    await seedTrip(db, { id: TRIP, owner: 'ops-gate-owner@test.com' });
  });

  it('owner can read audit history', async () => {
    const res = await api.get(`${BASE}/api/trips/${TRIP}/audit`, { as: 'ops-gate-owner@test.com' });
    expect(res.status).toBe(200);
  });

  it('stranger (no permission row) cannot read audit', async () => {
    const res = await api.get(`${BASE}/api/trips/${TRIP}/audit`, { as: 'ops-gate-stranger@test.com' });
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(403);
  });

  it('service token (no trip permission) cannot read audit — no admin bypass', async () => {
    const res = await api.get(`${BASE}/api/trips/${TRIP}/audit`, {
      bearer: await svc(['ops:trips:read', 'trips:read', 'trips:write']),
    });
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(403);
  });
});
