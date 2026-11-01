/**
 * Integration test — POST /api/trips/:id/recompute-travel
 * 走 HTTP 邊界（tests/api/http.ts），認證用真實 bearer token，不直接呼叫 handler。
 *
 * v2.24.0 spec + v2.30.0 mode_source DROPPED：
 *   - 1km gate (Haversine)：≤1km → mode='walking' + WALK API；>1km → 'driving' + DRIVE API
 *   - mode='transit' 既有 segment **不**覆寫（transit 自然代理 user override）
 *
 * Mock：computeRoute 用 vi.mock 攔截，不打真實 Google Routes API。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../../src/lib/maps/google-client', () => ({
  computeRoute: vi.fn(async (
    _apiKey: string,
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    mode: 'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE',
  ) => {
    // 用座標距離模擬 — WALK = 5km/h, DRIVE = 30km/h
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
import { computeRoute } from '../../src/lib/maps/google-client';
import { cleanupTrips } from './cleanup-trips';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;

async function setupTripWithEntries(tripId: string) {
  await seedTrip(db, { id: tripId });
  const day1 = await getDayId(db, tripId, 1);
  // 3 entries：A → B（500m, walk）, B → C（17km, drive）
  const poiA = await seedPoi(db, { name: 'A' });
  await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.3175, 127.7539, poiA).run();
  const poiB = await seedPoi(db, { name: 'B' });
  await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.3175, 127.7589, poiB).run(); // ~500m east
  const poiC = await seedPoi(db, { name: 'C' });
  await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.196, 127.6458, poiC).run(); // 那霸機場（~17km）
  // v2.29.0: seedEntry({poiId}) 已自動 INSERT trip_entry_pois sort_order=1。
  const e1 = await seedEntry(db, day1, { sortOrder: 1, poiId: poiA });
  const e2 = await seedEntry(db, day1, { sortOrder: 2, poiId: poiB });
  const e3 = await seedEntry(db, day1, { sortOrder: 3, poiId: poiC });
  return { e1, e2, e3 };
}

beforeEach(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-key' } as Partial<Env>);
  api = createApi({ env });
  // 清掉前次 segments + entries 避免 UNIQUE 衝突
  await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind('trip-rec%').run();
  await db.prepare('DELETE FROM trip_entries WHERE day_id IN (SELECT id FROM trip_days WHERE trip_id LIKE ?)').bind('trip-rec%').run();
  await db.prepare('DELETE FROM pois WHERE name IN (?, ?, ?)').bind('A', 'B', 'C').run();
});

afterAll(async () => {
  await cleanupTrips(db, ['trip-rec-%'], ['A', 'B', 'C', 'OtherA', 'OtherB', 'F1', 'F2', 'G1', 'G2', 'G3', 'NoCoordA', 'NoCoordB', 'yA-%', 'yB-%', 'yC-%']);
  await disposeMiniflare();
});

describe('POST /api/trips/:id/recompute-travel — 1km gate + segments', () => {
  it('A→B (500m) → walking segment + B→C (17km) → driving segment', async () => {
    const { e1, e2, e3 } = await setupTripWithEntries('trip-rec-1');
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-1/recompute-travel?day=all', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { pairsComputed: number; modeBreakdown: Record<string, number> };
    expect(body.pairsComputed).toBe(2);
    expect(body.modeBreakdown).toEqual({ walking: 1, driving: 1 });

    const segs = await db.prepare(
      'SELECT from_entry_id, to_entry_id, mode, source FROM trip_segments WHERE trip_id = ? ORDER BY from_entry_id',
    ).bind('trip-rec-1').all<{ from_entry_id: number; to_entry_id: number; mode: string; source: string }>();
    expect(segs.results).toHaveLength(2);
    expect(segs.results[0]).toMatchObject({ from_entry_id: e1, to_entry_id: e2, mode: 'walking', source: 'google' });
    expect(segs.results[1]).toMatchObject({ from_entry_id: e2, to_entry_id: e3, mode: 'driving', source: 'google' });
  });

  it('既有 mode=transit segment 被 skip（不覆寫）', async () => {
    const { e1, e2 } = await setupTripWithEntries('trip-rec-user');
    // 預先插一個 transit segment（A→B）user 手填 min
    const now = Date.now();
    await db.prepare(
      `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'transit', 999, NULL, 'manual', ?, ?)`,
    ).bind('trip-rec-user', e1, e2, now, now).run();

    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-user/recompute-travel?day=all', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { pairsSkippedTransit: number; pairsComputed: number };
    expect(body.pairsSkippedTransit).toBe(1);
    expect(body.pairsComputed).toBe(1); // 只算了 B→C

    // 驗 transit segment 沒被覆寫
    const seg = await db.prepare(
      'SELECT mode, "min" FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?',
    ).bind(e1, e2).first<{ mode: string; min: number }>();
    expect(seg).toMatchObject({ mode: 'transit', min: 999 });
  });

  it('既有 driving/walking segment 會被重新覆寫', async () => {
    const { e1, e2 } = await setupTripWithEntries('trip-rec-auto');
    const now = Date.now();
    await db.prepare(
      `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'driving', 100, 99999, 'google', ?, ?)`,
    ).bind('trip-rec-auto', e1, e2, now - 10000, now - 10000).run();

    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-auto/recompute-travel?day=all', { as: 'user@test.com' });
    expect(resp.status).toBe(200);

    // A→B 應被改回 walking（500m ≤ 1km）
    const seg = await db.prepare(
      'SELECT mode, "min", distance_m FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?',
    ).bind(e1, e2).first<{ mode: string; min: number; distance_m: number }>();
    expect(seg!.mode).toBe('walking');
    expect(seg!.distance_m).toBeLessThan(1000);
  });

  // 競態守衛：recompute 讀完既有 segment 之後、寫入之前，使用者把該段手動鎖定。
  // 以 Google 呼叫（vi.mock）當作插入點，在計算途中改寫真實 D1，驗證最終不覆蓋手動值。
  it('競態：計算途中該段被手動鎖定（既有列）→ 不覆蓋 manual 值', async () => {
    const { e1, e2 } = await setupTripWithEntries('trip-rec-race-upd');
    const now = Date.now();
    await db.prepare(
      `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'driving', 100, 99999, 'google', ?, ?)`,
    ).bind('trip-rec-race-upd', e1, e2, now - 10000, now - 10000).run();
    vi.mocked(computeRoute).mockImplementationOnce(async () => {
      await db.prepare(`UPDATE trip_segments SET source='manual', min=999 WHERE from_entry_id=? AND to_entry_id=?`).bind(e1, e2).run();
      return { polyline: 'mock', distance_meters: 500, duration_seconds: 360 };
    });

    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-race-upd/recompute-travel?day=all', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const seg = await db.prepare('SELECT source, "min" FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?').bind(e1, e2).first<{ source: string; min: number }>();
    expect(seg).toMatchObject({ source: 'manual', min: 999 });
  });

  it('競態：計算途中該段被手動建立（原本不存在）→ upsert 不覆蓋 manual 值', async () => {
    const { e1, e2 } = await setupTripWithEntries('trip-rec-race-ins');
    vi.mocked(computeRoute).mockImplementationOnce(async () => {
      const t = Date.now();
      await db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'transit', 999, NULL, 'manual', ?, ?)`,
      ).bind('trip-rec-race-ins', e1, e2, t, t).run();
      return { polyline: 'mock', distance_meters: 500, duration_seconds: 360 };
    });

    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-race-ins/recompute-travel?day=all', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const seg = await db.prepare('SELECT mode, source, "min" FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?').bind(e1, e2).first<{ mode: string; source: string; min: number }>();
    expect(seg).toMatchObject({ mode: 'transit', source: 'manual', min: 999 });
  });

  it('entry reorder 後清掉同日非相鄰 stale segments，只留下目前 pair', async () => {
    const { e1, e2, e3 } = await setupTripWithEntries('trip-rec-prune');
    const day2 = await getDayId(db, 'trip-rec-prune', 2);
    const otherPoiA = await seedPoi(db, { name: 'OtherA' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.3, 127.7, otherPoiA).run();
    const otherPoiB = await seedPoi(db, { name: 'OtherB' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.31, 127.71, otherPoiB).run();
    const otherE1 = await seedEntry(db, day2, { sortOrder: 1, poiId: otherPoiA });
    const otherE2 = await seedEntry(db, day2, { sortOrder: 2, poiId: otherPoiB });

    const now = Date.now();
    await db.batch([
      db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'driving', 11, 1100, 'google', ?, ?)`,
      ).bind('trip-rec-prune', e1, e2, now - 1000, now - 1000),
      db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'driving', 22, 2200, 'google', ?, ?)`,
      ).bind('trip-rec-prune', e2, e3, now - 1000, now - 1000),
      db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'driving', 33, 3300, 'google', ?, ?)`,
      ).bind('trip-rec-prune', otherE1, otherE2, now - 1000, now - 1000),
    ]);

    // Reorder day 1 from A,B,C to B,A,C. Old A->B and B->C are no longer adjacent.
    await db.batch([
      db.prepare('UPDATE trip_entries SET sort_order = 1 WHERE id = ?').bind(e2),
      db.prepare('UPDATE trip_entries SET sort_order = 2 WHERE id = ?').bind(e1),
      db.prepare('UPDATE trip_entries SET sort_order = 3 WHERE id = ?').bind(e3),
    ]);

    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-prune/recompute-travel?day=1', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { segmentsPruned: number };
    expect(body.segmentsPruned).toBe(2);

    const segs = await db.prepare(
      'SELECT from_entry_id, to_entry_id FROM trip_segments WHERE trip_id = ? ORDER BY from_entry_id, to_entry_id',
    ).bind('trip-rec-prune').all<{ from_entry_id: number; to_entry_id: number }>();
    expect(segs.results).toEqual([
      { from_entry_id: e1, to_entry_id: e3 },
      { from_entry_id: e2, to_entry_id: e1 },
      { from_entry_id: otherE1, to_entry_id: otherE2 },
    ]);
  });

  it('recompute day=1 也清掉 day=2 的 orphan segment（trip-wide prune，非只 scoped day）', async () => {
    await setupTripWithEntries('trip-rec-crossday');
    const day2 = await getDayId(db, 'trip-rec-crossday', 2);
    const f1poi = await seedPoi(db, { name: 'F1' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.5, 127.9, f1poi).run();
    const f2poi = await seedPoi(db, { name: 'F2' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.51, 127.91, f2poi).run();
    const f1 = await seedEntry(db, day2, { sortOrder: 1, poiId: f1poi });
    const f2 = await seedEntry(db, day2, { sortOrder: 2, poiId: f2poi });

    const now = Date.now();
    // day2 目前相鄰是 f1→f2；插一個反向 orphan f2→f1（曾 reorder / 刪景點殘留）
    await db.prepare(
      `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'driving', 88, 8800, 'google', ?, ?)`,
    ).bind('trip-rec-crossday', f2, f1, now - 1000, now - 1000).run();

    // 只 recompute day=1，但 day=2 的 orphan 也要被 trip-wide 清掉
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-crossday/recompute-travel?day=1', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { segmentsPruned: number };
    expect(body.segmentsPruned).toBe(1);

    // day2 反向 orphan f2→f1 應已被清（即使只 recompute day=1）
    const orphan = await db.prepare(
      'SELECT id FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?',
    ).bind(f2, f1).first();
    expect(orphan).toBeNull();
  });

  it('trip-wide prune 不誤清非 scoped day 的有效段（transit 手填 + NULL placeholder 都存活）', async () => {
    await setupTripWithEntries('trip-rec-keepvalid');
    const day2 = await getDayId(db, 'trip-rec-keepvalid', 2);
    const g1poi = await seedPoi(db, { name: 'G1' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.6, 128.0, g1poi).run();
    const g2poi = await seedPoi(db, { name: 'G2' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.61, 128.01, g2poi).run();
    const g3poi = await seedPoi(db, { name: 'G3' });
    await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.62, 128.02, g3poi).run();
    const g1 = await seedEntry(db, day2, { sortOrder: 1, poiId: g1poi });
    const g2 = await seedEntry(db, day2, { sortOrder: 2, poiId: g2poi });
    const g3 = await seedEntry(db, day2, { sortOrder: 3, poiId: g3poi });

    const now = Date.now();
    await db.batch([
      // g1→g2：user 手填 transit（min 不可重算，current-adjacent 不該被清）
      db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'transit', 55, NULL, 'manual', ?, ?)`,
      ).bind('trip-rec-keepvalid', g1, g2, now, now),
      // g2→g3：self-heal placeholder（既有段被標 stale：computed_at=NULL；current-adjacent 不該被清）
      db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'driving', NULL, NULL, 'google', NULL, ?)`,
      ).bind('trip-rec-keepvalid', g2, g3, now),
    ]);

    // 只 recompute day=1；day=2 的 transit + placeholder 皆 current-adjacent → 應存活
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-keepvalid/recompute-travel?day=1', { as: 'user@test.com' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { segmentsPruned: number };
    expect(body.segmentsPruned).toBe(0);

    const transitSeg = await db.prepare(
      'SELECT mode, "min" FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?',
    ).bind(g1, g2).first<{ mode: string; min: number }>();
    expect(transitSeg).toMatchObject({ mode: 'transit', min: 55 });

    const placeholderSeg = await db.prepare(
      'SELECT computed_at FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?',
    ).bind(g2, g3).first<{ computed_at: number | null }>();
    expect(placeholderSeg).not.toBeNull();
    expect(placeholderSeg!.computed_at).toBeNull();
  });

  // v2.29.0: 「dual-write trip_entries.travel_*」test removed — trip_entries.travel_* DROPPED。
  // travel 物件單一 source 改為 trip_segments（測在 days/days-num tests 涵蓋）。

  // 行為變更：新 api 只認 Bearer，沒有 CSRF gate；未認證一律 401（舊入口：無 Origin → 403 CSRF、帶 Origin → 401）
  it('未認證 → 401', async () => {
    await setupTripWithEntries('trip-rec-noauth');
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-noauth/recompute-travel', {
    });
    expect(resp.status).toBe(401);
  });

  it('未認證 → 401（且不寫入 segment）', async () => {
    await setupTripWithEntries('trip-rec-noauth-csrf');
    const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-noauth-csrf/recompute-travel?day=all');
    expect(resp.status).toBe(401);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM trip_segments WHERE trip_id = ?').bind('trip-rec-noauth-csrf').first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  // v2.55.45 — 自動 transit 方式（monorail/bus）現會被 recompute（舊碼跳過全部 transit）
  describe('transit submode auto-recompute (v2.55.45)', () => {
    // 那覇空港(cumKm 0) → 県庁前(6.0) → 首里(12.9)：貼 Yui 站座標。
    async function seed3AtYui(tripId: string) {
      await seedTrip(db, { id: tripId });
      const day1 = await getDayId(db, tripId, 1);
      const suffix = Math.random().toString(36).slice(2, 8);
      const mk = async (lat: number, lng: number, tag: string) => {
        const id = await seedPoi(db, { name: `${tag}-${suffix}` });
        await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(lat, lng, id).run();
        return id;
      };
      const pA = await mk(26.206515, 127.652214, 'yA'); // 那覇空港
      const pB = await mk(26.214446, 127.679343, 'yB'); // 県庁前
      const pC = await mk(26.219191, 127.725492, 'yC'); // 首里
      const e1 = await seedEntry(db, day1, { sortOrder: 1, poiId: pA });
      const e2 = await seedEntry(db, day1, { sortOrder: 2, poiId: pB });
      const e3 = await seedEntry(db, day1, { sortOrder: 3, poiId: pC });
      return { e1, e2, e3 };
    }
    const recompute = (tripId: string) =>
      api.request('POST', `https://test.com/api/trips/${tripId}/recompute-travel?day=all`, { as: 'user@test.com' });

    it('G1 既有 monorail（非 manual）→ 被重算，寫 source=haversine + Yui 值（此前跳過）', async () => {
      const { e1, e2 } = await seed3AtYui('trip-rec-mono');
      // 只留 e1→e2 一對：把 e3 移到別的 sort 讓 e2→e3 不相鄰（避免多算）— 簡化：直接刪 e3 段前置
      const now = Date.now();
      await db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'transit', 'monorail', 99, 111, 'haversine', NULL, ?)`,
      ).bind('trip-rec-mono', e1, e2, now).run();
      expect((await recompute('trip-rec-mono')).status).toBe(200);
      const seg = await db.prepare(
        'SELECT submode, "min", distance_m, source, computed_at FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?',
      ).bind(e1, e2).first<{ submode: string; min: number; distance_m: number; source: string; computed_at: number | null }>();
      expect(seg!.submode).toBe('monorail');
      expect(seg!.source).toBe('haversine');
      expect(seg!.min).toBe(15);        // 舊值 99 被重算成 Yui 那覇空港↔県庁前 = 15
      expect(seg!.distance_m).toBe(6000);
      expect(seg!.computed_at).not.toBeNull(); // 不再 stale
    });

    it('G2 既有 bus（非 manual）→ 走 Google DRIVE 代理重算，source=google', async () => {
      const { e1, e2 } = await seed3AtYui('trip-rec-bus');
      const now = Date.now();
      await db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'transit', 'bus', 5, 500, 'google', NULL, ?)`,
      ).bind('trip-rec-bus', e1, e2, now).run();
      expect((await recompute('trip-rec-bus')).status).toBe(200);
      const seg = await db.prepare(
        'SELECT submode, source, "min", computed_at FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?',
      ).bind(e1, e2).first<{ submode: string; source: string; min: number; computed_at: number | null }>();
      expect(seg!.submode).toBe('bus');
      expect(seg!.source).toBe('google');
      expect(seg!.min).toBeGreaterThan(0);
      expect(seg!.computed_at).not.toBeNull();
    });

    it('G2b 既有 train（非 manual、source=google）→ 走 Google DRIVE 代理重算、submode=train 保留（v2.55.72）', async () => {
      // metro/train/hsr 改為預設 DRIVE 自動（同 bus）後，其 source=google 段亦須被 recompute
      // DRIVE 重算，而非落入「假設 source=manual 而跳過」（recompute-travel 舊 fallback）。
      const { e1, e2 } = await seed3AtYui('trip-rec-train');
      const now = Date.now();
      await db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
         VALUES (?, ?, ?, 'transit', 'train', 9, 900, 'google', NULL, ?)`,
      ).bind('trip-rec-train', e1, e2, now).run();
      const resp = await recompute('trip-rec-train');
      expect(resp.status).toBe(200);
      const body = await resp.json() as { pairsSkippedTransit: number };
      expect(body.pairsSkippedTransit).toBe(0); // train 非 manual → 不跳過
      const seg = await db.prepare(
        'SELECT submode, source, "min", computed_at FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?',
      ).bind(e1, e2).first<{ submode: string; source: string; min: number; computed_at: number | null }>();
      expect(seg!.submode).toBe('train');   // 具體 submode 保留（非硬寫 bus）
      expect(seg!.source).toBe('google');
      expect(seg!.min).toBeGreaterThan(0);
      expect(seg!.computed_at).not.toBeNull();
    });

    it('G4 核心：同 recompute 中 manual transit 跳過、非 manual monorail 重算（source IS NOT manual 泛化）', async () => {
      const { e1, e2, e3 } = await seed3AtYui('trip-rec-mixed');
      const now = Date.now();
      await db.batch([
        // e1→e2：monorail 非 manual → 應被重算
        db.prepare(
          `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
           VALUES (?, ?, ?, 'transit', 'monorail', 88, 88, 'haversine', NULL, ?)`,
        ).bind('trip-rec-mixed', e1, e2, now),
        // e2→e3：手填鎖定（source=manual）→ 必跳過
        db.prepare(
          `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
           VALUES (?, ?, ?, 'transit', 'metro', 77, NULL, 'manual', ?, ?)`,
        ).bind('trip-rec-mixed', e2, e3, now, now),
      ]);
      const resp = await recompute('trip-rec-mixed');
      expect(resp.status).toBe(200);
      const body = await resp.json() as { pairsSkippedTransit: number };
      expect(body.pairsSkippedTransit).toBe(1); // 只有 manual 那段被跳

      const mono = await db.prepare('SELECT "min", source FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
        .bind(e1, e2).first<{ min: number; source: string }>();
      expect(mono!.min).toBe(15);        // monorail 被重算（88 → 15）
      expect(mono!.source).toBe('haversine');

      const manual = await db.prepare('SELECT "min", source, submode FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?')
        .bind(e2, e3).first<{ min: number; source: string; submode: string }>();
      expect(manual).toMatchObject({ min: 77, source: 'manual', submode: 'metro' }); // 鎖定值原封不動
    });

    it('N4 同一地點/免交通：no_travel=1 段 → recompute 跳過不覆寫（min/dist 維持 NULL）', async () => {
      const { e1, e2 } = await seed3AtYui('trip-rec-sp');
      const now = Date.now();
      // 刻意 source=NULL（非 manual）：專門驗 `|| no_travel===1` guard clause 獨立生效，
      // 而非靠 source='manual'。若 guard 沒判 no_travel，這段會被 gate 算成 driving（min>0）。
      await db.prepare(
        `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at, no_travel)
         VALUES (?, ?, ?, 'walking', NULL, NULL, NULL, NULL, ?, ?, 1)`,
      ).bind('trip-rec-sp', e1, e2, now, now).run();
      const res = await recompute('trip-rec-sp');
      expect(res.status).toBe(200);
      // mutation 驗證補強：SQL 的 no_travel guard 也會擋寫入，只看資料列分不出前置跳過有沒有生效；
      // 回應的 pairsSkippedTransit 是外部可見的訊號（被跳過的 pair 要被計為 skipped，不是 computed）
      const summary = await res.json() as { pairsSkippedTransit: number };
      expect(summary.pairsSkippedTransit).toBe(1);
      const seg = await db.prepare(
        'SELECT "min", distance_m, no_travel FROM trip_segments WHERE from_entry_id=? AND to_entry_id=?',
      ).bind(e1, e2).first<{ min: number | null; distance_m: number | null; no_travel: number | null }>();
      expect(seg!.no_travel).toBe(1);   // 旗標保留
      expect(seg!.min).toBeNull();       // 未被 Yui/Google 重算覆寫
      expect(seg!.distance_m).toBeNull();
    });
  });

  // v2.33.106 T-4: failure paths — 補既有 happy path 缺乏的 negative tests
  describe('failure paths (T-4)', () => {
    it('無寫權限 user → 403', async () => {
      await setupTripWithEntries('trip-rec-noperm');
      expect((await api.request('POST', 'https://test.com/api/trips/trip-rec-noperm/recompute-travel', { as: 'stranger@test.com' })).status).toBe(403);
    });

    it('trip 不存在 → 403（沒寫權限視為不存在）', async () => {
      const status = (await api.request('POST', 'https://test.com/api/trips/trip-rec-missing/recompute-travel', { as: 'user@test.com' })).status;
      expect([403, 404]).toContain(status);
    });

    it('trip 沒任何 entry → 0 pairs computed', async () => {
      await seedTrip(db, { id: 'trip-rec-empty' });
      const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-empty/recompute-travel?day=all', { as: 'user@test.com' });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { pairsComputed: number };
      expect(body.pairsComputed).toBe(0);
    });

    it('GOOGLE_MAPS_API_KEY 缺 → 500 / 502', async () => {
      const envNoKey = mockEnv(db);
      envNoKey.GOOGLE_MAPS_API_KEY = '';
      await setupTripWithEntries('trip-rec-nokey');
      const status = (await createApi({ env: envNoKey }).request('POST', 'https://test.com/api/trips/trip-rec-nokey/recompute-travel?day=all', { as: 'user@test.com' })).status;
      expect([500, 502]).toContain(status);
    });

    it('Entry 缺 lat/lng → pair 被 skip（不算 computed）', async () => {
      await seedTrip(db, { id: 'trip-rec-nocoord' });
      const day1 = await getDayId(db, 'trip-rec-nocoord', 1);
      const poiA = await seedPoi(db, { name: 'NoCoordA' });
      // 不更新 lat/lng → 預設 null
      const poiB = await seedPoi(db, { name: 'NoCoordB' });
      await db.prepare('UPDATE pois SET lat=?, lng=? WHERE id=?').bind(26.0, 127.0, poiB).run();
      await seedEntry(db, day1, { sortOrder: 1, poiId: poiA });
      await seedEntry(db, day1, { sortOrder: 2, poiId: poiB });

      const resp = await api.request('POST', 'https://test.com/api/trips/trip-rec-nocoord/recompute-travel?day=all', { as: 'user@test.com' });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { pairsComputed: number };
      // 缺 coords 的 pair 不該被算進 google route
      expect(body.pairsComputed).toBe(0);
    });
  });
});
