/**
 * Integration test — POST /api/trips/:id/segments
 * 走 HTTP 邊界（tests/api/http.ts），認證用真實 bearer token，不直接呼叫 handler。
 *
 * v2.55.x：手動建立 segment。recompute 尚未跑、segment 不存在時，user 從 EditEntryPage
 * 手動選移動方式（開車 / 步行 / 大眾運輸）→ POST 建立。
 *   - driving / walking → Google Routes 從 from/to entry master POI 座標重算，source='google'。
 *     缺座標 / 缺 API key → ok:false，INSERT min/distance=NULL（stale）。
 *   - transit → 必填 min（1–1440），source='manual'。
 *   - UNIQUE(from_entry_id, to_entry_id) → 同 pair 重送 = upsert（等同改 mode）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock computeRoute：座標距離模擬，WALK=5km/h DRIVE=30km/h（對齊 segments-patch test）
vi.mock('../../src/lib/maps/google-client', () => ({
  computeRoute: vi.fn(async (
    _apiKey: string,
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    mode: 'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE',
  ) => {
    const km = Math.sqrt(
      ((destination.lat - origin.lat) * 111) ** 2 +
      ((destination.lng - origin.lng) * 111 * Math.cos((origin.lat * Math.PI) / 180)) ** 2,
    );
    const distM = Math.round(km * 1000);
    const speedKmh = mode === 'WALK' ? 5 : 30;
    const seconds = Math.round((km / speedKmh) * 3600);
    return { polyline: 'mock', distance_meters: distM, duration_seconds: seconds };
  }),
}));

vi.mock('../../src/lib/maps-lock', () => ({
  assertGoogleAvailable: vi.fn(async () => undefined),
}));

import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, getDayId, seedEntry } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
let e1: number; // 有座標
let e2: number; // 有座標
let e3: number; // 無座標（測 fallback）

// pois 有 UNIQUE(name, type) + test DB 跨 test 共用 → POI 名須全域唯一
let poiSeq = 0;

/** seed 一個帶 master POI 座標的 entry，回 entry id。 */
async function seedEntryWithCoords(dayId: number, sortOrder: number, lat: number, lng: number): Promise<number> {
  poiSeq += 1;
  const poi = await db
    .prepare(`INSERT INTO pois (type, name, lat, lng) VALUES ('attraction', ?, ?, ?) RETURNING id`)
    .bind(`segpost-poi-${poiSeq}`, lat, lng)
    .first<{ id: number }>();
  return seedEntry(db, dayId, { sortOrder, poiId: poi!.id });
}

beforeEach(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-key' } as Partial<Env>);
  api = createApi({ env });
  await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind('trip-segpost%').run();
  await seedTrip(db, { id: 'trip-segpost' });
  const day1 = await getDayId(db, 'trip-segpost', 1);
  e1 = await seedEntryWithCoords(day1, 1, 24.0, 121.0);
  e2 = await seedEntryWithCoords(day1, 2, 24.1, 121.1);
  e3 = await seedEntry(db, day1, { sortOrder: 3 }); // 無 master POI → 無座標
});

afterAll(async () => {
  await cleanupTrips(db, ['trip-segpost%'], ['segpost-poi-%']);
  await disposeMiniflare();
});

function post(body: Record<string, unknown>) {
  return api.request('POST', 'https://test.com/api/trips/trip-segpost/segments', { json: body, as: 'user@test.com' });
}

describe('POST /api/trips/:id/segments', () => {
  it('driving 有座標 → 201 + source=google + min>0', async () => {
    const resp = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'driving' });
    expect(resp.status).toBe(201);
    const row = await db
      .prepare('SELECT mode, min, source, distance_m FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2)
      .first<{ mode: string; min: number; source: string; distance_m: number }>();
    expect(row!.mode).toBe('driving');
    expect(row!.source).toBe('google');
    expect(row!.min).toBeGreaterThan(0);
    expect(row!.distance_m).toBeGreaterThan(0);
  });

  it('transit + min=25（無 submode=其他）→ 201 + source=manual + submode=NULL + distance_m=Haversine 直線', async () => {
    // v2.55.45：手填方式（其他/metro/train/hsr）距離自動算直線 Haversine（非 NULL）。
    const resp = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', min: 25 });
    expect(resp.status).toBe(201);
    const row = await db
      .prepare('SELECT mode, submode, min, source, distance_m FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2)
      .first<{ mode: string; submode: string | null; min: number; source: string; distance_m: number | null }>();
    expect(row!.mode).toBe('transit');
    expect(row!.submode).toBeNull();
    expect(row!.min).toBe(25);
    expect(row!.source).toBe('manual');
    expect(row!.distance_m).toBeGreaterThan(0);
  });

  it('同 pair 重送 → upsert（改 mode，不建第二筆）', async () => {
    await post({ from_entry_id: e1, to_entry_id: e2, mode: 'driving' });
    const resp2 = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', min: 40 });
    expect(resp2.status).toBe(201);
    const rows = await db
      .prepare('SELECT id, mode, version FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2)
      .all<{ id: number; mode: string; version: number }>();
    expect(rows.results.length).toBe(1); // upsert，非新增
    expect(rows.results[0]!.mode).toBe('transit');
    expect(rows.results[0]!.version).toBeGreaterThan(0); // upsert bump version
  });

  it('driving 缺座標（entry 無 master POI）→ 201 + stale（source=NULL, min=NULL）', async () => {
    const resp = await post({ from_entry_id: e1, to_entry_id: e3, mode: 'driving' });
    expect(resp.status).toBe(201);
    const row = await db
      .prepare('SELECT mode, min, source, computed_at FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e3)
      .first<{ mode: string; min: number | null; source: string | null; computed_at: number | null }>();
    expect(row!.mode).toBe('driving');
    expect(row!.min).toBeNull();
    expect(row!.source).toBeNull();
    expect(row!.computed_at).toBeNull();
  });

  it('G8 transit + submode=bus（自動、不帶 min）→ 201 + source=google（Google DRIVE 代理）+ submode=bus', async () => {
    const resp = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', submode: 'bus' });
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT mode, submode, source, min FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2).first<{ mode: string; submode: string; source: string; min: number }>();
    expect(row).toMatchObject({ mode: 'transit', submode: 'bus', source: 'google' });
    expect(row!.min).toBeGreaterThan(0);
  });

  // v2.55.72：地鐵/火車/高鐵改為「預設用駕車 Google DRIVE 估車程距離、按了就存」（同 bus，
  // 單軌保留沖繩 Yui 特殊處理）。不再強制手填 min → 消除「選火車按關閉沒作用」的無聲丟失。
  it.each(['metro', 'train', 'hsr'])(
    'G8b transit + submode=%s（自動、不帶 min）→ 201 + source=google（DRIVE 代理）+ submode 保留 + min>0',
    async (submode) => {
      const resp = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', submode });
      expect(resp.status).toBe(201);
      const row = await db.prepare('SELECT mode, submode, source, min, distance_m FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
        .bind(e1, e2).first<{ mode: string; submode: string; source: string; min: number; distance_m: number }>();
      expect(row).toMatchObject({ mode: 'transit', submode, source: 'google' });
      expect(row!.min).toBeGreaterThan(0);
      expect(row!.distance_m).toBeGreaterThan(0);
    },
  );

  it('G10 transit + submode=metro + min=30（手填）→ 201 + source=manual + submode=metro + 距離直線 Haversine', async () => {
    const resp = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', submode: 'metro', min: 30 });
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT mode, submode, source, min, distance_m FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2).first<{ mode: string; submode: string; source: string; min: number; distance_m: number | null }>();
    expect(row).toMatchObject({ mode: 'transit', submode: 'metro', source: 'manual', min: 30 });
    expect(row!.distance_m).toBeGreaterThan(0);
  });

  // v2.55.72：transit 無 min 不再 400 — 非單軌一律預設 DRIVE 估（bare transit submode=NULL 同）。
  it('transit 無 submode 無 min → 201 + source=google（DRIVE 預設估）', async () => {
    const resp = await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit' });
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT mode, submode, source, min FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2).first<{ mode: string; submode: string | null; source: string; min: number }>();
    expect(row).toMatchObject({ mode: 'transit', submode: null, source: 'google' });
    expect(row!.min).toBeGreaterThan(0);
  });

  it('transit 無 submode 無 min 但缺座標 → 201 + stale（source=NULL）', async () => {
    // DRIVE 估缺座標 → computeGoogle ok:false → 存 NULL（同 driving 缺座標），仍建段不 400。
    const resp = await post({ from_entry_id: e1, to_entry_id: e3, mode: 'transit' });
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT mode, source, min FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e3).first<{ mode: string; source: string | null; min: number | null }>();
    expect(row!.mode).toBe('transit');
    expect(row!.source).toBeNull();
    expect(row!.min).toBeNull();
  });

  it('transit min 超範圍（>1440）→ 400', async () => {
    expect((await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', min: 9999 })).status).toBe(400);
  });

  it('invalid mode → 400', async () => {
    expect((await post({ from_entry_id: e1, to_entry_id: e2, mode: 'flying' })).status).toBe(400);
  });

  it('from === to → 400', async () => {
    expect((await post({ from_entry_id: e1, to_entry_id: e1, mode: 'driving' })).status).toBe(400);
  });

  it('from/to entry 不屬此 trip → 404（防 IDOR）', async () => {
    // 另一個 trip 的 entry
    await seedTrip(db, { id: 'trip-segpost-other' });
    const otherDay = await getDayId(db, 'trip-segpost-other', 1);
    const otherEntry = await seedEntry(db, otherDay, { sortOrder: 1 });
    expect((await post({ from_entry_id: e1, to_entry_id: otherEntry, mode: 'driving' })).status).toBe(404);
  });

  it('缺 from_entry_id → 400', async () => {
    expect((await post({ to_entry_id: e2, mode: 'driving' })).status).toBe(400);
  });

  it('transit min=0 → 400（min<1 收緊）', async () => {
    expect((await post({ from_entry_id: e1, to_entry_id: e2, mode: 'transit', min: 0 })).status).toBe(400);
  });

  // authz — 新 mutating endpoint 必鎖（requireAuth + hasWritePermission）
  // 行為變更：新 api 只認 Bearer，沒有 CSRF gate；未認證一律 401（舊入口：無 Origin → 403 CSRF、帶 Origin → 401）
  it('未認證 → 401', async () => {
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-segpost/segments', {
      json: { from_entry_id: e1, to_entry_id: e2, mode: 'driving' },
    });
    expect(resp.status).toBe(401);
  });

  it('未認證 → 401（且不建立 segment）', async () => {
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-segpost/segments', {
      json: { from_entry_id: e1, to_entry_id: e2, mode: 'driving' },
    });
    expect(resp.status).toBe(401);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?').bind(e1, e2).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('service token（無 trip write 權限）→ 403', async () => {
    // client_credentials 的 access token：user_id 為 NULL（真實 service token 形狀）
    const svcToken = `http-test-svc-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(
      svcToken,
      { jti: svcToken, client_id: 'svc-segpost', user_id: null, scopes: ['trips:read', 'trips:write'], grantId: `grant-${svcToken}` },
      300,
    );
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-segpost/segments', {
      json: { from_entry_id: e1, to_entry_id: e2, mode: 'driving' },
      bearer: svcToken,
    });
    expect(resp.status).toBe(403);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?').bind(e1, e2).first<{ n: number }>();
    expect(rows!.n).toBe(0); // 被擋下就不該有寫入
  });

  it('N-POST 同一地點/免交通：POST {noTravel:true}（不帶 mode）→ 201 + no_travel=1 + min/dist/source NULL', async () => {
    const resp = await post({ from_entry_id: e1, to_entry_id: e2, noTravel: true });
    expect(resp.status).toBe(201);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.noTravel).toBe(1);
    const row = await db
      .prepare('SELECT no_travel, "min", distance_m, source FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
      .bind(e1, e2)
      .first<{ no_travel: number | null; min: number | null; distance_m: number | null; source: string | null }>();
    expect(row!.no_travel).toBe(1);
    expect(row!.min).toBeNull();
    expect(row!.distance_m).toBeNull();
    expect(row!.source).toBeNull(); // no_travel=1 自足當 skip 訊號，source 不 overload 成 manual
  });
});
