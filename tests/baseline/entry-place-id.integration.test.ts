/**
 * #1598 — POST /api/trips/:id/days/:num/entries 轉送 place_id（fill-null，不覆寫）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser, seedTrip, seedPoi } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const owner = 'entry-place-id@test.com';
const tripId = 'trip-entry-place-id';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedUser(db, owner);
  await seedTrip(db, { id: tripId, owner, days: 1 });
});
afterAll(async () => {
  await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(tripId).run();
  await db.prepare('DELETE FROM trips WHERE id = ?').bind(tripId).run();
  await disposeMiniflare();
});

const addEntry = (json: Record<string, unknown>) =>
  api.request('POST', `/api/trips/${tripId}/days/1/entries`, { as: owner, json: { poi_type: 'attraction', source: 'google', lat: 26.2, lng: 127.7, ...json } });
const placeIdOf = (name: string) =>
  db.prepare("SELECT place_id FROM pois WHERE name = ? AND type = 'attraction'").bind(name).first<{ place_id: string | null }>().then((r) => r!.place_id);

describe('新增停留點的 place_id', () => {
  it('帶 place_id 建立新 POI → pois.place_id 有值', async () => {
    expect((await addEntry({ name: 'pid 新景點', place_id: 'ChIJ-new' })).status).toBe(201);
    expect(await placeIdOf('pid 新景點')).toBe('ChIJ-new');
  });

  it('POI 已有 place_id → 不被覆寫', async () => {
    const id = await seedPoi(db, { name: 'pid 既有', type: 'attraction' });
    await db.prepare('UPDATE pois SET place_id = ? WHERE id = ?').bind('ChIJ-old', id).run();
    expect((await addEntry({ name: 'pid 既有', place_id: 'ChIJ-other' })).status).toBe(201);
    expect(await placeIdOf('pid 既有')).toBe('ChIJ-old');
  });

  it('POI 尚無 place_id → 填入', async () => {
    await seedPoi(db, { name: 'pid 待補', type: 'attraction' });
    expect((await addEntry({ name: 'pid 待補', place_id: 'ChIJ-fill' })).status).toBe(201);
    expect(await placeIdOf('pid 待補')).toBe('ChIJ-fill');
  });

  it('不帶 place_id → 行為不變（維持 NULL）', async () => {
    expect((await addEntry({ name: 'pid 不帶' })).status).toBe(201);
    expect(await placeIdOf('pid 不帶')).toBeNull();
  });
});
