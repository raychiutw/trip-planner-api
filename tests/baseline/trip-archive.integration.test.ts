import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

// 走 HTTP 邊界（tests/api/http.ts）；共用 D1，專屬 trip／email，結束時清掉。
let db: D1Database;
let api: Api;
const tripId = 'archive-contract-1333';
const owner = 'archive-owner@example.test';
const member = 'archive-member@example.test';
const viewer = 'archive-viewer@example.test';
const outsider = 'archive-outsider@example.test';

const archive = (email: string, method: 'PUT' | 'DELETE', extra: { restrictTrip?: string; scopes?: string[] } = {}) =>
  api.request(method, `/api/trips/${tripId}/archive`, { as: email, ...extra });

async function listFor(email: string) {
  const response = await api.get('/api/my-trips', { as: email });
  expect(response.status).toBe(200);
  return response.json() as Promise<Array<{ tripId: string; archivedAt: string | null }>>;
}

/** client_credentials 式的 service token：user_id 為 null，帶 companion scope。 */
async function serviceToken(): Promise<string> {
  const token = `http-test-service-${crypto.randomUUID()}`;
  await new D1Adapter(db, 'AccessToken').upsert(
    token,
    { jti: token, client_id: 'http-test-service', user_id: null, scopes: ['companion'], grantId: `grant-${token}` },
    300,
  );
  return token;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: tripId, owner, published: 0 });
  for (const [email, role] of [[member, 'member'], [viewer, 'viewer']] as const) {
    await seedUser(db, email);
    await db.prepare('INSERT INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, ?)')
      .bind(userIdFor(email), tripId, role).run();
  }
});

afterAll(async () => {
  await cleanupTrips(db, [tripId]);
  await disposeMiniflare();
});

describe('owner-wide trip archive', () => {
  it('moves owner, member and viewer lists together, preserves access, and restores them together', async () => {
    for (const email of [owner, member, viewer]) {
      expect((await listFor(email)).find((trip) => trip.tripId === tripId)?.archivedAt).toBeNull();
    }

    const archived = await archive(owner, 'PUT');
    expect(archived.status).toBe(200);
    for (const email of [owner, member, viewer]) {
      expect((await listFor(email)).find((trip) => trip.tripId === tripId)?.archivedAt).toEqual(expect.any(String));
      const detail = await api.get(`/api/trips/${tripId}`, { as: email });
      expect(detail.status).toBe(200);
    }
    for (const email of [member, viewer, outsider]) {
      expect((await archive(email, 'DELETE')).status).toBe(403);
    }
    expect((await listFor(member)).find((trip) => trip.tripId === tripId)?.archivedAt).toEqual(expect.any(String));

    const restore = await archive(owner, 'DELETE');
    expect(restore.status).toBe(200);
    for (const email of [owner, member, viewer]) {
      expect((await listFor(email)).find((trip) => trip.tripId === tripId)?.archivedAt).toBeNull();
    }
  });

  it('rejects member, viewer, outsider, service token and restricted owner token without mutation', async () => {
    for (const email of [member, viewer, outsider]) {
      expect((await archive(email, 'PUT')).status).toBe(403);
    }
    expect((await api.request('PUT', `/api/trips/${tripId}/archive`, { bearer: await serviceToken() })).status).toBe(403);
    expect((await archive(owner, 'PUT', { restrictTrip: tripId })).status).toBe(403);
    expect((await archive(owner, 'PUT', { scopes: ['trips:read'] })).status).toBe(403);
    expect((await listFor(owner)).find((trip) => trip.tripId === tripId)?.archivedAt).toBeNull();
  });
});
