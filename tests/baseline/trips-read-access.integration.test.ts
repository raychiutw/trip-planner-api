/**
 * trips-read-access.integration.test.ts — v2.33.41 security audit fix
 *
 * Anonymous read of unpublished trips 之前是 wide-open hole（任何人知 tripId
 * 就讀全行程含 doc 航班 / hotel POI / 緊急聯絡）。本 spec 驗 `requireTripReadAccess`
 * helper 在每個 GET handler 的 wiring：
 *   - published=1 trip → anonymous OK
 *   - published=0 + anonymous → 403 PERM_DENIED
 *   - published=0 + member → OK
 *   - published=0 + non-member auth → 403
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

// 走 HTTP 邊界（tests/api/http.ts）；共用 D1，用專屬 id／email 並於結束時清掉。
let db: D1Database;
let api: Api;
const PUB = 'read-access-pub-trip';
const PRIV = 'read-access-priv-trip';
const OWNER = 'read-access-owner@test.com';
const STRANGER = 'read-access-stranger@test.com';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  // Published trip + unpublished trip
  await seedTrip(db, { id: PUB, owner: OWNER, published: 1 });
  await seedTrip(db, { id: PRIV, owner: OWNER, published: 0 });
});

afterAll(async () => {
  await cleanupTrips(db, [PUB, PRIV]);
  await disposeMiniflare();
});

describe('v2.33.41 trip read-access gate — published trip', () => {
  it('GET /trips/:id anonymous → 200 (published)', async () => {
    const resp = await api.get(`/api/trips/${PUB}`);
    expect(resp.status).toBe(200);
  });

  it('GET /trips/:id/segments anonymous → 200 (published)', async () => {
    const resp = await api.get(`/api/trips/${PUB}/segments`);
    expect(resp.status).toBe(200);
  });
});

describe('v2.33.41 trip read-access gate — unpublished trip blocks anonymous', () => {
  it('GET /trips/:id anonymous → 403 (private)', async () => {
    const resp = await api.get(`/api/trips/${PRIV}`);
    expect(resp.status).toBe(403);
  });



  it('GET /trips/:id/segments anonymous → 403 (private)', async () => {
    const resp = await api.get(`/api/trips/${PRIV}/segments`);
    expect(resp.status).toBe(403);
  });
});

describe('v2.33.41 trip read-access gate — owner / member access unpublished', () => {
  it('GET /trips/:id with owner auth → 200 (private)', async () => {
    const resp = await api.get(`/api/trips/${PRIV}`, { as: OWNER });
    expect(resp.status).toBe(200);
  });

  it('GET /trips/:id with non-member auth → 403 (private)', async () => {
    const resp = await api.get(`/api/trips/${PRIV}`, { as: STRANGER });
    expect(resp.status).toBe(403);
  });
});

describe('v2.33.41 trip read-access gate — nonexistent trip', () => {
  it('GET /trips/nonexistent anonymous → 404', async () => {
    const resp = await api.get('/api/trips/read-access-nonexistent-trip');
    expect(resp.status).toBe(404);
  });
});
