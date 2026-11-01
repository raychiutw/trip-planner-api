/**
 * Integration test — GET/PUT/DELETE /api/trips/:id
 *
 * 走 HTTP 邊界（tests/api/http.ts）：認證用真實 bearer token，不直接呼叫 handler。
 * 共用 D1：用專屬 trip id／email，結束時清掉自己建立的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

let db: D1Database;
let api: Api;

const TRIP = 'trips-id-http-trip';
const OWNER = 'trips-id-owner@test.com';
const STRANGER = 'trips-id-stranger@test.com';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
});

afterAll(async () => {
  await db.prepare('DELETE FROM trip_destinations WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('GET /api/trips/:id', () => {
  it('取得行程 meta', async () => {
    const resp = await api.get(`/api/trips/${TRIP}`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.tripId).toBe(TRIP);
  });

  it('不存在 → 404', async () => {
    expect((await api.get('/api/trips/trips-id-http-nope')).status).toBe(404);
  });
});

describe('PUT /api/trips/:id', () => {
  const put = (json: unknown, as: string | null = OWNER) =>
    api.request('PUT', `/api/trips/${TRIP}`, { as: as ?? undefined, json });

  it('更新行程 → 200', async () => {
    const resp = await put({ title: '新標題' });
    expect(resp.status).toBe(200);
    const trip = await db.prepare('SELECT title FROM trips WHERE id = ?').bind(TRIP).first();
    expect((trip as Record<string, unknown>).title).toBe('新標題');
  });

  it('未認證 → 401', async () => {
    expect((await put({ title: 'x' }, null)).status).toBe(401);
  });

  it('無權限 → 403', async () => {
    expect((await put({ title: 'x' }, STRANGER)).status).toBe(403);
    const trip = await db.prepare('SELECT title FROM trips WHERE id = ?').bind(TRIP).first();
    expect((trip as Record<string, unknown>).title).not.toBe('x');
  });

  // OSM PR (migration 0045)：destinations[] full-replacement semantics on PUT。
  it('帶 destinations[] → 全量取代 trip_destinations + scalar field 一起更新', async () => {
    // v2.29.0: trip_destinations.{osm_id, osm_type} DROPPED.
    await db.prepare(
      `INSERT INTO trip_destinations (trip_id, dest_order, name, lat, lng, day_quota)
       VALUES (?, 0, '原沖繩', 26.21, 127.68, 5)`,
    ).bind(TRIP).run();

    const resp = await put({
      title: '帶 dest 的更新',
      destinations: [
        { name: '京都', lat: 35.01, lng: 135.76, day_quota: 3 },
        { name: '大阪', lat: 34.69, lng: 135.50, day_quota: 2 },
      ],
    });
    expect(resp.status).toBe(200);

    const trip = await db.prepare('SELECT title FROM trips WHERE id = ?').bind(TRIP).first();
    expect((trip as Record<string, unknown>).title).toBe('帶 dest 的更新');

    const dests = await db.prepare(
      'SELECT name, dest_order, day_quota FROM trip_destinations WHERE trip_id = ? ORDER BY dest_order',
    ).bind(TRIP).all();
    expect(dests.results).toHaveLength(2);
    expect((dests.results[0] as Record<string, unknown>).name).toBe('京都');
    expect((dests.results[0] as Record<string, unknown>).day_quota).toBe(3);
    expect((dests.results[1] as Record<string, unknown>).name).toBe('大阪');
    // Old 「原沖繩」 should be gone (full-replacement)
    const old = await db.prepare("SELECT name FROM trip_destinations WHERE trip_id = ? AND name = '原沖繩'")
      .bind(TRIP).first();
    expect(old).toBeNull();
  });

  it('帶空 destinations[] → 清光 trip_destinations', async () => {
    await db.prepare(
      `INSERT INTO trip_destinations (trip_id, dest_order, name) VALUES (?, 0, '臨時')`,
    ).bind(TRIP).run();

    const resp = await put({ destinations: [] });
    expect(resp.status).toBe(200);

    const dests = await db.prepare(
      'SELECT COUNT(*) as cnt FROM trip_destinations WHERE trip_id = ?',
    ).bind(TRIP).first();
    expect((dests as Record<string, unknown>).cnt).toBe(0);
  });

  // 2026-05-02 follow-up: enum validation defense-in-depth
  // v2.31.36 (migration 0068): default_travel_mode test removed — column dropped。

  it('lang 非 enum 值 → 400', async () => {
    expect((await put({ lang: 'klingon' })).status).toBe(400);
  });

  it('body 完全空 → 400', async () => {
    expect((await put({})).status).toBe(400);
  });

  // /review-fix: hostile payload guards
  it('destinations 數量超過上限 (>30) → 400', async () => {
    const tooMany = Array.from({ length: 31 }, (_, i) => ({ name: `dest-${i}`, osm_id: 1000 + i }));
    const resp = await put({ destinations: tooMany });
    expect(resp.status).toBe(400);
  });

  it('sub_areas 不是 string array → 寫入 NULL（防 nested object 撐爆 row）', async () => {
    const resp = await put({
      destinations: [
        { name: '惡意 sub_areas', sub_areas: { nested: { deeply: 'evil' } }, osm_id: 999 },
      ],
    });
    expect(resp.status).toBe(200);
    const dest = await db.prepare('SELECT sub_areas FROM trip_destinations WHERE trip_id = ? AND name = ?')
      .bind(TRIP, '惡意 sub_areas').first();
    expect((dest as Record<string, unknown>).sub_areas).toBeNull();
  });

  it('sub_areas 是 string array → 正常 JSON 寫入', async () => {
    const resp = await put({
      destinations: [
        { name: '正常 sub_areas', sub_areas: ['梅田', '難波'], osm_id: 998 },
      ],
    });
    expect(resp.status).toBe(200);
    const dest = await db.prepare('SELECT sub_areas FROM trip_destinations WHERE trip_id = ? AND name = ?')
      .bind(TRIP, '正常 sub_areas').first();
    expect(JSON.parse((dest as Record<string, unknown>).sub_areas as string)).toEqual(['梅田', '難波']);
  });
});

describe('DELETE /api/trips/:id', () => {
  // mutation 驗證時發現「只有 owner 能刪」沒被守住（拿掉 owner 檢查測試仍全綠），補上
  it('無權限的陌生人 → 403，行程仍在', async () => {
    const resp = await api.request('DELETE', `/api/trips/${TRIP}`, { as: STRANGER });
    expect(resp.status).toBe(403);
    expect(await db.prepare('SELECT 1 FROM trips WHERE id = ?').bind(TRIP).first()).toBeTruthy();
  });

  it('有編輯權的共編者（非 owner）→ 403，行程仍在', async () => {
    const editorEmail = 'trips-id-editor@test.com';
    await seedTrip(db, { id: 'trips-id-editor-seed', owner: editorEmail }); // 只為建立該使用者
    const uid = (await db.prepare('SELECT id FROM users WHERE email = ?').bind(editorEmail).first<{ id: string }>())!.id;
    await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'member')").bind(uid, TRIP).run();
    try {
      const resp = await api.request('DELETE', `/api/trips/${TRIP}`, { as: editorEmail });
      expect(resp.status).toBe(403);
      expect(await db.prepare('SELECT 1 FROM trips WHERE id = ?').bind(TRIP).first()).toBeTruthy();
    } finally {
      await cleanupTrips(db, ['trips-id-editor-seed']);
    }
  });

  it('受限 token（restrict_trip）→ 403，即使是 owner 且目標就是 scoped trip（v2.55.56 confused-deputy）', async () => {
    // 受限 token 不可刪任何 trip（destructive，超出內容編輯 agent 職權）；assertNotTripRestricted
    // 在任何 DB mutation 前就擋下 → 行程不會被刪，後續測試不受影響。
    const resp = await api.request('DELETE', `/api/trips/${TRIP}`, {
      as: OWNER,
      restrictTrip: TRIP,
    });
    expect(resp.status).toBe(403);
    // 確認行程仍在
    const still = await db.prepare('SELECT 1 FROM trips WHERE id = ?').bind(TRIP).first();
    expect(still).toBeTruthy();
  });
});
