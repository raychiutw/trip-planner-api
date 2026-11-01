/**
 * Integration test — GET /api/trips/:id/days（含 summary + ?all=1 batch 模式）
 * 走 HTTP 邊界（tests/api/http.ts），不直接呼叫 handler。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, seedPoi, seedHotelForDay, seedEntryAlternate, getDayId } from './helpers';
import { createApi, type Api } from './http';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });

  // Trip A: 5 天，Day1 和 Day2 有 entries 和 canonical stopPois（測 cross-day isolation）
  await seedTrip(db, { id: 'trip-days', days: 5 });
  const d1Id = await getDayId(db, 'trip-days', 1);
  const d2Id = await getDayId(db, 'trip-days', 2);

  // Phase 3：spatial 透過 poi JOIN，不再用 entry.location JSON
  const d1EntryPoiId = await seedPoi(db, { type: 'attraction', name: '測試地點' });
  await db.prepare(
    'UPDATE pois SET lat = 26.5, lng = 127.9 WHERE id = ?'
  ).bind(d1EntryPoiId).run();

  const d1EntryId = await seedEntry(db, d1Id, {
    sortOrder: 0,
    poiId: d1EntryPoiId,
  });
  const d2EntryId = await seedEntry(db, d2Id, { sortOrder: 0 });

  // Day1 restaurant POI (作為 alternate)
  const d1RestId = await seedPoi(db, { type: 'restaurant', name: 'Day1 Restaurant' });
  await seedEntryAlternate(db, { entryId: d1EntryId, poiId: d1RestId, sortOrder: 2 });

  // Day2 restaurant POI (作為 master via seedEntry poiId? 不行—d2EntryId 已建。手動 INSERT master row)
  const d2RestId = await seedPoi(db, { type: 'restaurant', name: 'Day2 Restaurant' });
  await db.prepare(
    'INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)',
  ).bind(d2EntryId, d2RestId).run();

  // Day1 shopping POI — v2.29.0 改用 trip_entry_pois alternate (sort_order >= 2)
  // 注意：shopping 'mustBuy' field 在 v2.29.0 cutover 後不再 surface 自獨立 schema
  // （shopping POI 改為 alternates 中 type='shopping' 的 POI，由 frontend filter）。
  const d1ShopId = await seedPoi(db, { type: 'shopping', name: 'Day1 Shop' });
  await seedEntryAlternate(db, { entryId: d1EntryId, poiId: d1ShopId, sortOrder: 3 });

  // Day1 hotel + parking — v2.29.0 用 trip_days.hotel_poi_id + poi_relations
  const d1HotelId = await seedPoi(db, { type: 'hotel', name: 'Day1 Hotel' });
  await seedHotelForDay(db, d1Id, d1HotelId);

  const d1ParkId = await seedPoi(db, { type: 'parking', name: 'Day1 Parking' });
  await db.prepare(
    `INSERT INTO poi_relations (poi_id, related_poi_id, relation_type) VALUES (?, ?, 'parking')`,
  ).bind(d1HotelId, d1ParkId).run();

  // Trip B: 3 天，無任何 entry / POI（測 fetchPoiMap empty branch）
  await seedTrip(db, { id: 'trip-empty', days: 3 });

  // Trip C: travel segment 測試專用 trip（day1 兩 entries 之間有 segment）
  await seedTrip(db, { id: 'trip-travel', days: 2 });
  const travelD1Id = await getDayId(db, 'trip-travel', 1);
  const travelE1 = await seedEntry(db, travelD1Id, { sortOrder: 0 });
  const travelE2 = await seedEntry(db, travelD1Id, { sortOrder: 1 });
  await db.prepare(
    `INSERT INTO trip_segments
     (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
     VALUES (?, ?, ?, 'driving', 30, NULL, NULL, ?, ?)`,
  ).bind('trip-travel', travelE1, travelE2, Date.now(), Date.now()).run();
});

afterAll(disposeMiniflare);

describe('GET /api/trips/:id/days — summary 模式', () => {
  it('列出所有天（不含 timeline / hotel）', async () => {
    const path = '/api/trips/trip-days/days';
    const resp = await api.get(path);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data).toHaveLength(5);
    expect(data[0]!.dayNum).toBe(1);
    expect(data[4]!.dayNum).toBe(5);
    // summary 模式只回傳輕量欄位
    expect(data[0]!.timeline).toBeUndefined();
    expect(data[0]!.hotel).toBeUndefined();
  });

  it('不存在的行程 → 404 (v2.33.41 security: trip read access 先檢查存在)', async () => {
    const path = '/api/trips/nope/days';
    const resp = await api.get(path);
    expect(resp.status).toBe(404);
  });
});

describe('GET /api/trips/:id/days?all=1 — batch 模式', () => {
  it('回傳完整 days 含 timeline / hotel / POI', async () => {
    const path = '/api/trips/trip-days/days?all=1';
    const resp = await api.get(path);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data).toHaveLength(5);

    const day1 = data[0]!;
    expect(day1.dayNum).toBe(1);
    expect(Array.isArray(day1.timeline)).toBe(true);
    expect((day1.timeline as unknown[]).length).toBe(1);
  });

  it('POI 不跨天洩漏（Day1/Day2 stopPois 嚴格隔離）', async () => {
    const path = '/api/trips/trip-days/days?all=1';
    const resp = await api.get(path);
    const data = await resp.json() as Array<Record<string, unknown>>;

    const d1Timeline = data[0]!.timeline as Array<Record<string, unknown>>;
    const d1Pois = d1Timeline[0]!.stopPois as Array<Record<string, unknown>>;
    expect(d1Pois.find(p => p.name === 'Day1 Restaurant')).toBeDefined();
    expect(d1Pois.find(p => p.name === 'Day2 Restaurant')).toBeUndefined();

    const d2Timeline = data[1]!.timeline as Array<Record<string, unknown>>;
    const d2Pois = d2Timeline[0]!.stopPois as Array<Record<string, unknown>>;
    expect(d2Pois.find(p => p.name === 'Day2 Restaurant')).toBeDefined();
    expect(d2Pois.find(p => p.name === 'Day1 Restaurant')).toBeUndefined();
  });

  it('hotel context 正確歸類（含 parking 附加）', async () => {
    const path = '/api/trips/trip-days/days?all=1';
    const resp = await api.get(path);
    const data = await resp.json() as Array<Record<string, unknown>>;

    const d1 = data[0]!;
    expect(d1.hotel).toBeTruthy();
    const hotel = d1.hotel as Record<string, unknown>;
    expect(hotel.name).toBe('Day1 Hotel');
    expect(Array.isArray(hotel.parking)).toBe(true);
    const parking = hotel.parking as Array<Record<string, unknown>>;
    expect(parking).toHaveLength(1);
    expect(parking[0]!.name).toBe('Day1 Parking');

    // Day2 沒有 hotel
    expect(data[1]!.hotel).toBeNull();
  });

  it('shopping POI（v2.29.0 改 alternate type=shopping）出現在 stopPois', async () => {
    const path = '/api/trips/trip-days/days?all=1';
    const resp = await api.get(path);
    const data = await resp.json() as Array<Record<string, unknown>>;

    const d1Timeline = data[0]!.timeline as Array<Record<string, unknown>>;
    // v2.29.0：entry.shopping array 廢除，shopping POI 改放 stopPois (type='shopping')
    const stopPois = d1Timeline[0]!.stopPois as Array<Record<string, unknown>>;
    const shopPoi = stopPois.find(p => p.type === 'shopping');
    expect(shopPoi).toBeDefined();
    expect(shopPoi!.name).toBe('Day1 Shop');
  });

  it('entry travel 物件來自 trip_segments', async () => {
    // v2.29.0: trip_entries.travel_* DROPPED；travel 從 trip_segments 取
    const path = '/api/trips/trip-travel/days?all=1';
    const resp = await api.get(path);
    const data = await resp.json() as Array<Record<string, unknown>>;

    const d1Timeline = data[0]!.timeline as Array<Record<string, unknown>>;
    expect(d1Timeline).toHaveLength(2);
    // segment 以 from_entry_id 為 key，所以 E1 (sortOrder=0) entry 帶 travel；
    // E2 (sortOrder=1) 是 to_entry，沒人指它出去 → travel=null
    const travel = d1Timeline[0]!.travel as Record<string, unknown> | null;
    expect(travel).toEqual({
      type: 'car',
      submode: null, // v2.55.45 (A1)：travel 物件帶 submode；driving → null
      sameplace: false, // v2.55.46：travel 物件帶 sameplace；正常段 → false
      desc: null,
      min: 30,
      distanceM: null,
      source: null,
    });
    expect(d1Timeline[1]!.travel).toBeNull();
  });

  it('v2.55.45 (A1)：transit 段的 submode surface 到 days?all=1（分享/列印面能顯具體方式）', async () => {
    // day2 seed 一段 transit monorail → assembled travel 必帶 submode，否則唯讀/列印面
    // 掉回 generic「大眾運輸」（A1 完整性）。
    const d2 = await getDayId(db, 'trip-travel', 2);
    const m1 = await seedEntry(db, d2, { sortOrder: 0 });
    const m2 = await seedEntry(db, d2, { sortOrder: 1 });
    await db.prepare(
      `INSERT INTO trip_segments
       (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at)
       VALUES (?, ?, ?, 'transit', 'monorail', 15, 6000, 'haversine', ?, ?)`,
    ).bind('trip-travel', m1, m2, Date.now(), Date.now()).run();

    const resp = await api.get('/api/trips/trip-travel/days?all=1');
    const data = await resp.json() as Array<Record<string, unknown>>;
    const d2Timeline = data[1]!.timeline as Array<Record<string, unknown>>;
    const travel = d2Timeline[0]!.travel as Record<string, unknown>;
    expect(travel).toMatchObject({ type: 'transit', submode: 'monorail', min: 15 });
  });

  it('v2.55.46：no_travel 段的 sameplace surface 到 days?all=1（分享/列印收合「同一地點」）', async () => {
    // 獨立 trip（beforeAll 持久狀態 → 不共用 trip-travel 的 d2，避免 entry 順序撞測）。
    await seedTrip(db, { id: 'trip-sp-days', days: 1 });
    const d1 = await getDayId(db, 'trip-sp-days', 1);
    const m1 = await seedEntry(db, d1, { sortOrder: 0 });
    const m2 = await seedEntry(db, d1, { sortOrder: 1 });
    await db.prepare(
      `INSERT INTO trip_segments
       (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at, no_travel)
       VALUES (?, ?, ?, 'walking', NULL, NULL, NULL, 'manual', ?, ?, 1)`,
    ).bind('trip-sp-days', m1, m2, Date.now(), Date.now()).run();

    const resp = await api.get('/api/trips/trip-sp-days/days?all=1');
    const data = await resp.json() as Array<Record<string, unknown>>;
    const timeline = data[0]!.timeline as Array<Record<string, unknown>>;
    const travel = timeline[0]!.travel as Record<string, unknown>; // m1（from_entry）帶 m1→m2 段
    expect(travel).toMatchObject({ sameplace: true });
  });

  it('Phase 3：entry.master 取 canonical POI master（取代舊 entry.location JSON）', async () => {
    const path = '/api/trips/trip-days/days?all=1';
    const resp = await api.get(path);
    const data = await resp.json() as Array<Record<string, unknown>>;

    const d1Timeline = data[0]!.timeline as Array<Record<string, unknown>>;
    const master = d1Timeline[0]!.master as Record<string, unknown>;
    expect(master).toBeTruthy();
    expect(master.lat).toBe(26.5);
    expect(master.lng).toBe(127.9);
    expect(master.name).toBe('測試地點');
    expect('poi' in d1Timeline[0]!).toBe(false);
  });

  it('空行程（有天但無 POI）不 crash，回傳空 hotel/timeline', async () => {
    const path = '/api/trips/trip-empty/days?all=1';
    const resp = await api.get(path);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);
    data.forEach(day => {
      expect(day.hotel).toBeNull();
      expect(day.timeline).toEqual([]);
    });
  });

  it('不存在的行程 → 404 (v2.33.41 security: trip read access 先檢查存在)', async () => {
    const path = '/api/trips/nope/days?all=1';
    const resp = await api.get(path);
    expect(resp.status).toBe(404);
  });

  it('batch 輸出與 single-day 端點每日資料完全一致（regression guard）', async () => {
    // Batch
    const batchPath = '/api/trips/trip-days/days?all=1';
    const batchResp = await api.get(batchPath);
    const batchData = await batchResp.json() as Array<Record<string, unknown>>;

    // Day 1 through 5 via single-day endpoint
    for (const dayNum of [1, 2, 3, 4, 5]) {
      const singlePath = `/api/trips/trip-days/days/${dayNum}`;
      const singleResp = await api.get(singlePath);
      const singleData = await singleResp.json() as Record<string, unknown>;
      const batchDay = batchData[dayNum - 1];

      // 深度比對（序列化後字串相等）確保 assembleDay 兩端產出完全一致
      expect(JSON.stringify(batchDay)).toBe(JSON.stringify(singleData));
    }
  });
});
