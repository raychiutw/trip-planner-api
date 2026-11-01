/**
 * Integration test — PATCH /api/trips/:id/segments/:sid
 * 走 HTTP 邊界（tests/api/http.ts），認證用真實 bearer token，不直接呼叫 handler。
 *
 * v2.30.0：mode_source DROPPED。contract：
 *   - mode='transit' → 必填 min（Japan Routes 無 transit 資料），source='manual'，不打 API
 *   - mode='driving' / 'walking' 不帶 min → 一律 Google Routes 重算，source='google'
 *
 * v2.55.45：交通方式細分 submode + 自動方式可手動覆寫。
 *   - 自動方式（driving/walking/monorail/bus）帶 body.min → 手動覆寫鎖定（source='manual'、
 *     保留 body.min、距離改直線）；不帶 min → 恢復自動算。submode 省略 = 保留現值。
 *
 * v2.26.2 regression：mode 從 driving 切 walking（或反向）→ backend 必須自動
 * call Google Routes 重算 min（不能保留舊 mode 的時間）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock computeRoute：用座標距離模擬，WALK=5km/h DRIVE=30km/h
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
import { mockEnv, seedTrip, getDayId, seedEntry, seedPoi } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
let segId: number;

beforeEach(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  // 清掉前次 segments 避免 UNIQUE 衝突
  await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind('trip-segp%').run();
  await seedTrip(db, { id: 'trip-segp' });
  const day1 = await getDayId(db, 'trip-segp', 1);
  const e1 = await seedEntry(db, day1, { sortOrder: 1 });
  const e2 = await seedEntry(db, day1, { sortOrder: 2 });
  const now = Date.now();
  const r = await db.prepare(
    `INSERT INTO trip_segments
     (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
     VALUES (?, ?, ?, 'walking', 5, 400, 'google', ?, ?) RETURNING id`,
  ).bind('trip-segp', e1, e2, now, now).first<{ id: number }>();
  segId = r!.id;
});

afterAll(async () => {
  await cleanupTrips(db, ['trip-segp', 'trip-other-segp', 'trip-segr', 'trip-segm', 'trip-sp'], ['segr-%', 'segm-%', 'sp-%']);
  await disposeMiniflare();
});

describe('PATCH /api/trips/:id/segments/:sid', () => {
  it('mode=driving → 200 + mode 改了（缺 coords / 缺 API key 走 fallback，computed_at=NULL 標 stale）', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, { json: { mode: 'driving' }, as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const updated = await db.prepare('SELECT mode, computed_at FROM trip_segments WHERE id = ?').bind(segId).first<{ mode: string; computed_at: number | null }>();
    expect(updated!.mode).toBe('driving');
    expect(updated!.computed_at).toBeNull();
  });

  // v2.55.72：transit 無 min 不再 400 — 非單軌一律預設 DRIVE 估。此 fixture 無座標＋無 API key
  // → computeGoogle ok:false → 軟失敗：改 mode/submode、source=NULL + computed_at=NULL 標 stale，
  // 保留舊 min/distance（不覆寫）。仍回 200（不再強制手填）。
  it('mode=transit 無 min → 200 + stale（DRIVE 估軟失敗：source/computed_at=NULL，不再 400）', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, { json: { mode: 'transit' }, as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const updated = await db.prepare('SELECT mode, source, computed_at FROM trip_segments WHERE id = ?').bind(segId)
      .first<{ mode: string; source: string | null; computed_at: number | null }>();
    expect(updated!.mode).toBe('transit');
    expect(updated!.source).toBeNull();     // 軟失敗清 source（不留舊 google 鎖定）
    expect(updated!.computed_at).toBeNull(); // 標 stale
  });

  it('mode=transit + min=30（無 submode=其他、此 fixture 無座標）→ 200 + source=manual + distance_m=NULL', async () => {
    // v2.55.45：手填方式距離自動算直線 Haversine，但此 fixture 的 entry 無 POI 座標
    // → Haversine 無法算 → distance_m 保持 NULL（有座標的情況見 segments-post 測試）。
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, { json: { mode: 'transit', min: 30 }, as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const updated = await db.prepare('SELECT mode, "min", source, distance_m FROM trip_segments WHERE id = ?').bind(segId).first<{ mode: string; min: number; source: string; distance_m: number | null }>();
    expect(updated!.mode).toBe('transit');
    expect(updated!.min).toBe(30);
    expect(updated!.source).toBe('manual');
    expect(updated!.distance_m).toBeNull();
  });

  it('mode=transit + min=99999 (> 1440 上界) → 400', async () => {
    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, { json: { mode: 'transit', min: 99999 }, as: 'user@test.com' })).status).toBe(400);
  });

  it('mode invalid (flying) → 400', async () => {
    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, { json: { mode: 'flying' }, as: 'user@test.com' })).status).toBe(400);
  });

  // 行為變更：新 api 只認 Bearer，沒有 CSRF gate；未認證一律 401（舊入口：無 Origin → 403 CSRF、帶 Origin → 401）
  it('未認證 → 401', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, {
      json: { mode: 'walking' },
    });
    expect(resp.status).toBe(401);
  });

  it('未認證 → 401（且 segment 不被改動）', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, { json: { mode: 'driving' } });
    expect(resp.status).toBe(401);
    const row = await db.prepare('SELECT mode FROM trip_segments WHERE id = ?').bind(segId).first<{ mode: string }>();
    expect(row!.mode).toBe('walking');
  });

  // mutation 驗證時發現原本沒有守這道門（拿掉 requireTripWrite 測試仍全綠），補上
  it('無寫入權限的使用者 → 403，且 segment 不被改動', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, {
      json: { mode: 'driving' },
      as: 'stranger-segp@test.com',
    });
    expect(resp.status).toBe(403);
    const row = await db.prepare('SELECT mode, "min" FROM trip_segments WHERE id = ?').bind(segId).first<{ mode: string; min: number }>();
    expect(row).toMatchObject({ mode: 'walking', min: 5 });
  });

  // 同上：樂觀鎖（expectedVersion）原本無測試守護
  it('expectedVersion 與現值不符 → 不套用變更', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segp/segments/${segId}`, {
      json: { mode: 'driving', expectedVersion: 9999 },
      as: 'user@test.com',
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).toBeLessThan(500);
    const row = await db.prepare('SELECT mode FROM trip_segments WHERE id = ?').bind(segId).first<{ mode: string }>();
    expect(row!.mode).toBe('walking');
  });

  it('segment 不屬於該 trip → 404 (IDOR 防護)', async () => {
    await seedTrip(db, { id: 'trip-other-segp' });
    expect((await api.request('PATCH', `https://test.com/api/trips/trip-other-segp/segments/${segId}`, { json: { mode: 'walking' }, as: 'user@test.com' })).status).toBe(404);
  });
});

// v2.26.2 regression — mode 切換後 min 自動重算
describe('PATCH /api/trips/:id/segments/:sid — mode change auto-recompute (v2.26.2)', () => {
  let segIdR: number;

  beforeEach(async () => {
    await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind('trip-segr%').run();
    // 用 override env 補上 GOOGLE_MAPS_API_KEY（recompute path 必須）
    env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-google-key' });
    api = createApi({ env });
    await seedTrip(db, { id: 'trip-segr' });
    const day1 = await getDayId(db, 'trip-segr', 1);
    // 9.3km apart：mock computeRoute → DRIVE ~18min, WALK ~111min
    const suffix = Math.random().toString(36).slice(2, 8);
    const poiA = await seedPoi(db, { name: `segr-A-${suffix}` });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.4937, 127.9202, poiA).run();
    const poiB = await seedPoi(db, { name: `segr-B-${suffix}` });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.5687, 127.8826, poiB).run();
    // v2.29.0: seedEntry({poiId}) 已自動 INSERT trip_entry_pois sort_order=1。
    const e1 = await seedEntry(db, day1, { sortOrder: 1, poiId: poiA });
    const e2 = await seedEntry(db, day1, { sortOrder: 2, poiId: poiB });
    const now = Date.now();
    // 起始為 driving / 18min（mock 速度算出）
    const r = await db.prepare(
      `INSERT INTO trip_segments
       (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'driving', 18, 9300, 'google', ?, ?) RETURNING id`,
    ).bind('trip-segr', e1, e2, now, now).first<{ id: number }>();
    segIdR = r!.id;
  });

  it('mode driving→walking 不帶 min → backend 重算 min（不保留 driving 時間）', async () => {
    const resp = await api.request('PATCH', `https://test.com/api/trips/trip-segr/segments/${segIdR}`, { json: { mode: 'walking' }, as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const updated = await db.prepare('SELECT mode, "min", source, distance_m FROM trip_segments WHERE id = ?')
      .bind(segIdR).first<{ mode: string; min: number; source: string; distance_m: number }>();
    expect(updated!.mode).toBe('walking');
    expect(updated!.source).toBe('google');     // 重算來自 Google Routes
    // 9.3km / 5km/h ≈ 111 min；不該保留 driving 的 18 min
    expect(updated!.min).toBeGreaterThanOrEqual(90);
    expect(updated!.min).toBeLessThanOrEqual(130);
  });

  it('mode walking→driving 不帶 min → backend 重算 min（不保留 walking 時間）', async () => {
    // 先改成 walking baseline
    await db.prepare('UPDATE trip_segments SET mode = ?, "min" = ? WHERE id = ?').bind('walking', 111, segIdR).run();

    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segr/segments/${segIdR}`, { json: { mode: 'driving' }, as: 'user@test.com' })).status).toBe(200);
    const updated = await db.prepare('SELECT mode, "min", source FROM trip_segments WHERE id = ?')
      .bind(segIdR).first<{ mode: string; min: number; source: string }>();
    expect(updated!.mode).toBe('driving');
    expect(updated!.source).toBe('google');
    // 9.3km / 30km/h ≈ 18 min；不該保留 walking 的 111 min
    expect(updated!.min).toBeGreaterThanOrEqual(15);
    expect(updated!.min).toBeLessThanOrEqual(25);
  });

  it('v2.55.45：mode=walking 帶 body.min → 手動覆寫鎖定（source=manual、保留 body.min、不再自動算）', async () => {
    // v2.30.0 舊契約是「driving/walking 忽略 body.min 強制 Google 重算」；v2.55.45 起
    // 自動方式（駕車/步行/單軌/公車）可手填覆寫 → 鎖定該值、source='manual'、距離改直線。
    // 「恢復自動計算」= 前端重送不帶 min（見下一 test）。
    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segr/segments/${segIdR}`, { json: { mode: 'walking', min: 42 }, as: 'user@test.com' })).status).toBe(200);
    const updated = await db.prepare('SELECT mode, "min", source, distance_m FROM trip_segments WHERE id = ?')
      .bind(segIdR).first<{ mode: string; min: number; source: string; distance_m: number | null }>();
    expect(updated!.mode).toBe('walking');
    expect(updated!.min).toBe(42);            // body.min 保留（手動覆寫）
    expect(updated!.source).toBe('manual');    // 鎖定，非 google
    expect(updated!.distance_m).toBeGreaterThan(0); // 距離改直線 Haversine（fixture 有座標）
  });

  it('v2.55.45：覆寫後重送不帶 min → 恢復自動計算（source 回 google、min 重算）', async () => {
    // 先手填覆寫成 manual/42
    await db.prepare('UPDATE trip_segments SET mode=?, "min"=?, source=? WHERE id=?')
      .bind('walking', 42, 'manual', segIdR).run();
    // 重送不帶 min → 回自動 Google 重算
    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segr/segments/${segIdR}`, { json: { mode: 'walking' }, as: 'user@test.com' })).status).toBe(200);
    const updated = await db.prepare('SELECT mode, "min", source FROM trip_segments WHERE id = ?')
      .bind(segIdR).first<{ mode: string; min: number; source: string }>();
    expect(updated!.mode).toBe('walking');
    expect(updated!.source).toBe('google');    // 恢復自動
    expect(updated!.min).toBeGreaterThanOrEqual(90); // 9.3km/5km/h ≈ 111，非保留的 42
    expect(updated!.min).toBeLessThanOrEqual(130);
  });

  it('entries 缺 coords → 保留舊 min（不能 call Google，fallback）', async () => {
    // 把 POI 座標清掉模擬缺資料
    await db
      .prepare(
        `UPDATE pois SET lat=NULL, lng=NULL
         WHERE id IN (
           SELECT tep.poi_id
           FROM trip_entry_pois tep
           WHERE tep.sort_order = 1
             AND tep.entry_id IN (SELECT from_entry_id FROM trip_segments WHERE id = ?)
         )`,
      )
      .bind(segIdR)
      .run();
    await db
      .prepare(
        `UPDATE pois SET lat=NULL, lng=NULL
         WHERE id IN (
           SELECT tep.poi_id
           FROM trip_entry_pois tep
           WHERE tep.sort_order = 1
             AND tep.entry_id IN (SELECT to_entry_id FROM trip_segments WHERE id = ?)
         )`,
      )
      .bind(segIdR)
      .run();

    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segr/segments/${segIdR}`, { json: { mode: 'walking' }, as: 'user@test.com' })).status).toBe(200);
    const updated = await db.prepare('SELECT mode, "min" FROM trip_segments WHERE id = ?')
      .bind(segIdR).first<{ mode: string; min: number }>();
    expect(updated!.mode).toBe('walking');
    expect(updated!.min).toBe(18); // 保留原 driving 時間（fallback）
  });

  it('v2.55.45：source=manual 段切 auto 遇 soft-fail（缺座標）→ source 重置 NULL（可自癒，非永久鎖定）', async () => {
    // correctness review Finding 1：soft-fail 分支若不清 source，manual 段切 auto 撞 quota/缺座標
    // 會永遠停在 source='manual' → recompute 的 `source IS NOT 'manual'` guard 永久跳過 → 不自癒。
    await db.prepare('UPDATE trip_segments SET mode=?, source=?, "min"=? WHERE id=?')
      .bind('driving', 'manual', 50, segIdR).run();
    // 清兩端座標 → 切 walking 時 computeGoogle ok:false（soft-fail）
    for (const col of ['from_entry_id', 'to_entry_id']) {
      await db.prepare(
        `UPDATE pois SET lat=NULL, lng=NULL WHERE id IN (
           SELECT tep.poi_id FROM trip_entry_pois tep
           WHERE tep.sort_order = 1 AND tep.entry_id IN (SELECT ${col} FROM trip_segments WHERE id = ?))`,
      ).bind(segIdR).run();
    }
    expect((await api.request('PATCH', `https://test.com/api/trips/trip-segr/segments/${segIdR}`, { json: { mode: 'walking' }, as: 'user@test.com' })).status).toBe(200);
    const updated = await db.prepare('SELECT mode, source, computed_at FROM trip_segments WHERE id = ?')
      .bind(segIdR).first<{ mode: string; source: string | null; computed_at: number | null }>();
    expect(updated!.mode).toBe('walking');
    expect(updated!.source).toBeNull();      // 關鍵：不再是 'manual' → recompute 可自癒
    expect(updated!.computed_at).toBeNull();  // stale，待自癒
  });
});

// v2.55.45 — transit submode 自動/手動方式 dispatch（單軌本地表 / 公車 Google DRIVE 代理）
describe('PATCH /api/trips/:id/segments/:sid — transit submode dispatch (v2.55.45)', () => {
  let smSegId: number;

  // 那覇空港 / 県庁前 = Yui 站座標（cumKm 0 / 6.0）；far = 離全線 >1200m。
  const NAHA = { lat: 26.206515, lng: 127.652214 };
  const KENCHO = { lat: 26.214446, lng: 127.679343 };
  const FAR = { lat: 26.5, lng: 128.0 };

  // seed 一段 transit segment（可帶 submode/source），兩端 POI 給定座標。
  async function seedTransitSeg(
    a: { lat: number; lng: number } | null,
    b: { lat: number; lng: number } | null,
    seg: { submode: string | null; min: number | null; source: string | null },
  ): Promise<number> {
    const day1 = await getDayId(db, 'trip-segm', 1);
    const suffix = Math.random().toString(36).slice(2, 8);
    const mk = async (pt: { lat: number; lng: number } | null, tag: string) => {
      const id = await seedPoi(db, { name: `segm-${tag}-${suffix}` });
      if (pt) await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(pt.lat, pt.lng, id).run();
      else await db.prepare('UPDATE pois SET lat=NULL, lng=NULL WHERE id=?').bind(id).run();
      return id;
    };
    const poiA = await mk(a, 'A');
    const poiB = await mk(b, 'B');
    const e1 = await seedEntry(db, day1, { sortOrder: 1, poiId: poiA });
    const e2 = await seedEntry(db, day1, { sortOrder: 2, poiId: poiB });
    const now = Date.now();
    const r = await db.prepare(
      `INSERT INTO trip_segments
       (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'transit', ?, ?, NULL, ?, ?, ?) RETURNING id`,
    ).bind('trip-segm', e1, e2, seg.submode, seg.min, seg.source, now, now).first<{ id: number }>();
    return r!.id;
  }

  const patch = (body: Record<string, unknown>) =>
    api.request('PATCH', `https://test.com/api/trips/trip-segm/segments/${smSegId}`, { json: body, as: 'user@test.com' });

  const readSeg = () => db.prepare('SELECT mode, submode, "min", source, distance_m, computed_at FROM trip_segments WHERE id = ?')
    .bind(smSegId).first<{ mode: string; submode: string | null; min: number | null; source: string | null; distance_m: number | null; computed_at: number | null }>();

  beforeEach(async () => {
    await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind('trip-segm%').run();
    env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-google-key' });
    api = createApi({ env });
    await seedTrip(db, { id: 'trip-segm' });
  });

  it('G5 單軌自動：POI 貼近 Yui 站、不帶 min → computeMonorail → source=haversine、submode=monorail、min=15、dist=6000', async () => {
    smSegId = await seedTransitSeg(NAHA, KENCHO, { submode: 'monorail', min: null, source: null });
    expect((await patch({ mode: 'transit', submode: 'monorail' })).status).toBe(200);
    const u = await readSeg();
    expect(u!.source).toBe('haversine');
    expect(u!.submode).toBe('monorail');
    expect(u!.min).toBe(15);        // walk(1)+rail(13)+walk(1)，那覇空港↔県庁前 cumKm 0↔6
    expect(u!.distance_m).toBe(6000); // railMeters(6.0km)
  });

  it('G6a 單軌 too_far：兩端離全線 >1200m → 400', async () => {
    smSegId = await seedTransitSeg(FAR, { lat: 26.6, lng: 128.1 }, { submode: 'monorail', min: null, source: null });
    expect((await patch({ mode: 'transit', submode: 'monorail' })).status).toBe(400);
  });

  it('G6b 單軌 same_station：兩端最近站相同 → 400（建議步行）', async () => {
    smSegId = await seedTransitSeg(NAHA, { lat: 26.2069, lng: 127.6525 }, { submode: 'monorail', min: null, source: null });
    expect((await patch({ mode: 'transit', submode: 'monorail' })).status).toBe(400);
  });

  it('G7 單軌缺座標 → soft-fail（保留舊 min、source=NULL、computed_at=NULL，可自癒非 400）', async () => {
    smSegId = await seedTransitSeg(null, null, { submode: 'monorail', min: 15, source: 'haversine' });
    expect((await patch({ mode: 'transit', submode: 'monorail' })).status).toBe(200);
    const u = await readSeg();
    expect(u!.min).toBe(15);          // 保留舊值
    expect(u!.source).toBeNull();      // 軟失敗清 source → recompute 可自癒
    expect(u!.computed_at).toBeNull();
  });

  it('G8 公車自動：不帶 min → computeGoogle DRIVE 代理 → source=google、submode=bus、min/dist>0', async () => {
    smSegId = await seedTransitSeg(NAHA, KENCHO, { submode: 'bus', min: null, source: null });
    expect((await patch({ mode: 'transit', submode: 'bus' })).status).toBe(200);
    const u = await readSeg();
    expect(u!.source).toBe('google');
    expect(u!.submode).toBe('bus');
    expect(u!.min).toBeGreaterThan(0);
    expect(u!.distance_m).toBeGreaterThan(0);
  });

  it('G10 手填地鐵：submode=metro + min=30 → source=manual、submode=metro 保留、距離直線 Haversine>0', async () => {
    smSegId = await seedTransitSeg(NAHA, KENCHO, { submode: null, min: null, source: null });
    expect((await patch({ mode: 'transit', submode: 'metro', min: 30 })).status).toBe(200);
    const u = await readSeg();
    expect(u!.source).toBe('manual');
    expect(u!.submode).toBe('metro');
    expect(u!.min).toBe(30);
    expect(u!.distance_m).toBeGreaterThan(0);
  });

  it('G9a preserve-on-omit：段現為 monorail，PATCH {min} 省略 submode → 保留 monorail、鎖 manual', async () => {
    // pill 改其他欄位 / EditEntryPage 非交通編輯不動 submode → 省略 = 保留現值。
    smSegId = await seedTransitSeg(NAHA, KENCHO, { submode: 'monorail', min: 15, source: 'haversine' });
    expect((await patch({ mode: 'transit', min: 20 })).status).toBe(200);
    const u = await readSeg();
    expect(u!.submode).toBe('monorail'); // 保留
    expect(u!.min).toBe(20);
    expect(u!.source).toBe('manual');    // 帶 min → 鎖定
  });

  it('G9b clear-on-null (F1)：EditEntryPage 3-mode 編輯器送 submode:null → 清成 generic transit（不再鎖成單軌）', async () => {
    // F1 回歸：舊 3-mode 編輯器選「大眾運輸」填分鐘，顯式送 submode:null → 清除細分，
    // 否則 preserve-on-omit 會保留 monorail 並鎖 manual = 選 generic 卻得鎖定的單軌。
    smSegId = await seedTransitSeg(NAHA, KENCHO, { submode: 'monorail', min: 15, source: 'haversine' });
    expect((await patch({ mode: 'transit', submode: null, min: 20 })).status).toBe(200);
    const u = await readSeg();
    expect(u!.submode).toBeNull();       // 清除 → generic 大眾運輸
    expect(u!.min).toBe(20);
    expect(u!.source).toBe('manual');
  });
});

describe('PATCH /api/trips/:id/segments/:sid — 同一地點/免交通 (v2.55.46)', () => {
  let segId: number;
  const NAHA = { lat: 26.206515, lng: 127.652214 };
  const KENCHO = { lat: 26.214446, lng: 127.679343 };

  async function seedSeg(seg: { mode: string; min: number | null; source: string | null; noTravel?: number | null }): Promise<number> {
    const day1 = await getDayId(db, 'trip-sp', 1);
    const suffix = Math.random().toString(36).slice(2, 8);
    const mk = async (pt: { lat: number; lng: number }, tag: string) => {
      const id = await seedPoi(db, { name: `sp-${tag}-${suffix}` });
      await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(pt.lat, pt.lng, id).run();
      return id;
    };
    const e1 = await seedEntry(db, day1, { sortOrder: 1, poiId: await mk(NAHA, 'A') });
    const e2 = await seedEntry(db, day1, { sortOrder: 2, poiId: await mk(KENCHO, 'B') });
    const now = Date.now();
    const r = await db.prepare(
      `INSERT INTO trip_segments
       (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at, no_travel)
       VALUES (?, ?, ?, ?, NULL, ?, 9400, ?, ?, ?, ?) RETURNING id`,
    ).bind('trip-sp', e1, e2, seg.mode, seg.min, seg.source, now, now, seg.noTravel ?? null).first<{ id: number }>();
    return r!.id;
  }

  const patch = (body: Record<string, unknown>) =>
    api.request('PATCH', `https://test.com/api/trips/trip-sp/segments/${segId}`, { json: body, as: 'user@test.com' });

  const readSeg = () => db.prepare('SELECT mode, submode, "min", source, distance_m, computed_at, no_travel FROM trip_segments WHERE id = ?')
    .bind(segId).first<{ mode: string; submode: string | null; min: number | null; source: string | null; distance_m: number | null; computed_at: number | null; no_travel: number | null }>();

  beforeEach(async () => {
    await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind('trip-sp%').run();
    env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-google-key' });
    api = createApi({ env });
    await seedTrip(db, { id: 'trip-sp' });
  });

  it('N1 標記免交通：driving 段 PATCH {noTravel:true} → no_travel=1、min/dist NULL、source=manual、computed_at 有值、mode 保留', async () => {
    segId = await seedSeg({ mode: 'driving', min: 21, source: 'google' });
    const res = await patch({ noTravel: true });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.noTravel).toBe(1); // 回應 snake→camel
    const u = await readSeg();
    expect(u!.no_travel).toBe(1);
    expect(u!.min).toBeNull();
    expect(u!.distance_m).toBeNull();
    expect(u!.source).toBeNull();            // source 不設 manual — no_travel=1 自足當 recompute skip 訊號
    expect(u!.computed_at).not.toBeNull();   // 防前端 stale chip
    expect(u!.mode).toBe('driving');          // mode 有 NOT NULL CHECK → 不動、保留
  });

  it('N2 恢復交通：先免交通、再 PATCH {mode:driving} → no_travel 清成 NULL', async () => {
    segId = await seedSeg({ mode: 'driving', min: null, source: 'manual', noTravel: 1 });
    expect((await patch({ mode: 'driving' })).status).toBe(200);
    expect((await readSeg())!.no_travel).toBeNull();
  });

  it('N3 免交通不需 mode：PATCH {noTravel:true} 不帶 mode → 200（繞過 mode 驗證）', async () => {
    segId = await seedSeg({ mode: 'walking', min: 8, source: 'google' });
    expect((await patch({ noTravel: true })).status).toBe(200);
    expect((await readSeg())!.no_travel).toBe(1);
  });
});
