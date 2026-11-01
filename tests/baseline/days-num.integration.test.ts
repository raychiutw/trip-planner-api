/**
 * Integration test — GET/PUT /api/trips/:id/days/:num
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const OWNER = 'days-num-owner@test.com';
// 匿名的瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 handler 的 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
const tripIds: string[] = [];
/** 建立行程並記下 id，afterAll 清掉（共用 D1）。 */
const seed = async (opts: { id: string; days?: number; owner?: string }) => {
  tripIds.push(opts.id);
  return seedTrip(db, { owner: OWNER, ...opts });
};

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: BROWSER_ORIGIN }) });
  await seed({ id: 'trip-dn', days: 3 });
});

afterAll(async () => {
  // 共用 D1：只清自己建立的行程（days / entries 等子表走 FK cascade，permissions 要手動清）
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

describe('GET /api/trips/:id/days/:num', () => {
  it('取得完整一天資料', async () => {
    const resp = await api.request('GET', '/api/trips/trip-dn/days/1');
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.dayNum).toBe(1);
    expect(data.timeline).toBeDefined();
  });

  it('不存在的天 → 404', async () => {
    expect((await api.request('GET', '/api/trips/trip-dn/days/99')).status).toBe(404);
  });
});

describe('PUT /api/trips/:id/days/:num', () => {
  it('覆寫整天 + 建立 entry + find-or-create POI → 200', async () => {
    const resp = await api.request('PUT', '/api/trips/trip-dn/days/1', { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'Day 1',
        timeline: [
          {
            time: '09:00',
            name: '首里城',
            description: '世界遺產',
            stopPois: [
              { name: 'すし三昧', type: 'restaurant' },
            ],
          },
          {
            time: '12:00',
            name: '國際通',
            travel: { type: 'car', desc: '車程', min: 20 },
          },
        ],
        hotel: {
          name: 'ホテルオリオン',
          checkout: '11:00',
        },
      } });
    expect(resp.status).toBe(200);

    // 驗證 entries 已建立
    const dayId = await getDayId(db, 'trip-dn', 1);
    const entries = await db.prepare(
      'SELECT * FROM trip_entries WHERE day_id = ? ORDER BY sort_order'
    ).bind(dayId).all();
    expect(entries.results).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(entries.results[0] as Record<string, unknown>, 'title')).toBe(false);
    const restaurantPoi = await db
      .prepare("SELECT id FROM pois WHERE name = 'すし三昧' AND type = 'restaurant'")
      .first<{ id: number }>();
    expect(restaurantPoi).not.toBeNull();
    // v2.29.0: trip_entries.poi_id DROPPED. master POI 改放 trip_entry_pois.sort_order=1。
    const entryPoi = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order')
      .bind((entries.results[0] as Record<string, unknown>).id)
      .all<{ poi_id: number; sort_order: number }>();
    // master (sort_order=1) is the entry's primary POI; stop POIs surface as alternates.
    expect(entryPoi.results[0]).toEqual({ poi_id: restaurantPoi!.id, sort_order: 1 });

    // 驗證 hotel POI 已建立
    const hotelPoi = await db.prepare(
      "SELECT id FROM pois WHERE name = 'ホテルオリオン' AND type = 'hotel'"
    ).first<{ id: number }>();
    expect(hotelPoi).not.toBeNull();

    // v2.29.0: trip_pois DROPPED. Hotel 改用 trip_days.hotel_poi_id。
    const dayRow = await db.prepare(
      'SELECT hotel_poi_id FROM trip_days WHERE id = ?',
    ).bind(dayId).first<{ hotel_poi_id: number | null }>();
    expect(dayRow!.hotel_poi_id).toBe(hotelPoi!.id);
  });

  it('缺 date → 400', async () => {
    expect((await api.request('PUT', '/api/trips/trip-dn/days/1', { as: OWNER, json: {
        dayOfWeek: '三',
        label: 'x',
      } })).status).toBe(400);
  });

  it.each(['weather', 'weather_json'])('舊天氣欄位 %s → 400，不得靜默忽略', async (field) => {
    const resp = await api.request('PUT', '/api/trips/trip-dn/days/1', { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'Day 1',
        timeline: [],
        [field]: { label: '那霸' },
      } });
    expect(resp.status).toBe(400);
    const data = await resp.json() as { error?: { detail?: string } };
    expect(data.error?.detail ?? '').toContain(`${field} 已移除`);
  });

  it('只要帶舊 restaurants entry 欄位就拒絕，避免 runtime fallback', async () => {
    const resp = await api.request('PUT', '/api/trips/trip-dn/days/1', { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'Day 1',
        timeline: [
          {
            time: '12:00',
            name: '午餐',
            restaurants: [],
          },
        ],
      } });
    expect(resp.status).toBe(400);
    const data = await resp.json() as { error?: { detail?: string } };
    expect(data.error?.detail ?? '').toContain('restaurants 已移除');
  });

  it('timeline entry 舊 title 欄位 → 400，避免回到 entry title fallback', async () => {
    const resp = await api.request('PUT', '/api/trips/trip-dn/days/1', { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'Day 1',
        timeline: [{ time: '12:00', title: '午餐' }],
      } });
    expect(resp.status).toBe(400);
    const data = await resp.json() as { error?: { detail?: string } };
    expect(data.error?.detail ?? '').toContain('title 已移除');
  });

  it('未認證 → 401', async () => {
    expect((await api.request('PUT', '/api/trips/trip-dn/days/1', { headers: { Origin: BROWSER_ORIGIN }, json: {
        date: '2026-04-01', dayOfWeek: '三', label: 'x',
      } })).status).toBe(401);
  });

  it('無權限 → 403', async () => {
    expect((await api.request('PUT', '/api/trips/trip-dn/days/1', { as: 'stranger@test.com', json: {
        date: '2026-04-01', dayOfWeek: '三', label: 'x',
      } })).status).toBe(403);
  });

  it('亂碼偵測 → 400', async () => {
    expect((await api.request('PUT', '/api/trips/trip-dn/days/2', { as: OWNER, json: {
        date: '2026-04-02', dayOfWeek: '四', label: 'Day 2',
        timeline: [{ time: '10:00', name: 'test\uFFFDgarbled' }],
      } })).status).toBe(400);
  });

  /* Phase 2 POI Unification (v2.1.2.0+) */
  it('Phase 2: entry with maps + poi_type → 寫入 trip_entry_pois master + pois master', async () => {
    expect((await api.request('PUT', '/api/trips/trip-dn/days/3', { as: OWNER, json: {
        date: '2026-04-03', dayOfWeek: '五', label: 'Day 3',
        timeline: [
          {
            time: '09:00',
            // 專屬名稱（dn- 前綴）：對照組的消毒副本裡有真實 POI（如「那覇空港」），不能假設資料庫裡沒有同名的
            name: 'dn-那覇空港',
            poi_type: 'transport',
            // Migration 0045: maps dropped, google_rating renamed to rating.
            rating: 4.2,
          },
          {
            time: '12:00',
            name: 'dn-首里城',
            maps: 'https://www.google.com/maps/search/首里城',
          },
        ],
      } })).status).toBe(200);

    const dayId = await getDayId(db, 'trip-dn', 3);
    const entries = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order',
    ).bind(dayId).all<{ id: number }>();
    expect(entries.results).toHaveLength(2);
    // v2.29.0: trip_entries.poi_id DROPPED. master POI 改查 trip_entry_pois.sort_order=1。
    for (const e of entries.results) {
      const master = await db.prepare(
        'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
      ).bind(e.id).first<{ poi_id: number }>();
      expect(master).not.toBeNull();
      expect(master!.poi_id).toBeGreaterThan(0);
    }

    // Migration 0045: pois.maps dropped (use mapsUrl helper); google_rating renamed to rating.
    const transportPoi = await db.prepare(
      "SELECT id, rating FROM pois WHERE name = 'dn-那覇空港' AND type = 'transport'",
    ).first() as { id: number; rating: number } | null;
    expect(transportPoi).not.toBeNull();
    expect(transportPoi!.rating).toBe(4.2);

    const attractionPoi = await db.prepare(
      "SELECT id FROM pois WHERE name = 'dn-首里城' AND type = 'attraction'",
    ).first();
    expect(attractionPoi).not.toBeNull();
  });

  it('Phase 2: GET /days/:num 回傳 canonical master JOIN 物件', async () => {
    const resp = await api.request('GET', '/api/trips/trip-dn/days/3');
    expect(resp.status).toBe(200);
    const data = await resp.json() as { timeline: Array<{ master: { name: string; type: string } | null; stopPois?: Array<{ type: string; sortOrder: number }> }> };
    const transportEntry = data.timeline.find((e) => e.master?.name === 'dn-那覇空港');
    expect(transportEntry).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(transportEntry as Record<string, unknown>, 'title')).toBe(false);
    expect(transportEntry!.master).not.toBeNull();
    expect(transportEntry!.master!.type).toBe('transport');
    expect(transportEntry!.stopPois?.[0]).toMatchObject({ type: 'transport', sortOrder: 1 });
    expect('poi' in transportEntry!).toBe(false);
  });

  it('Phase 2: POST /entries 建立 POI 並掛上 master (trip_entry_pois sort_order=1)', async () => {
    const resp = await api.request('POST', '/api/trips/trip-dn/days/2/entries', { as: OWNER, json: {
        name: '美麗海水族館',
        time: '10:00',
        poi_type: 'attraction',
        // Migration 0045: maps dropped, google_rating renamed to rating.
        rating: 4.5,
      } });
    expect(resp.status).toBe(201);
    const row = await resp.json() as { id: number };
    expect(row.id).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(row as Record<string, unknown>, 'title')).toBe(false);

    // v2.29.0: trip_entries.poi_id DROPPED. 從 trip_entry_pois 查 master。
    const master = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(row.id).first<{ poi_id: number }>();
    expect(master).not.toBeNull();
    expect(master!.poi_id).toBeGreaterThan(0);

    const poi = await db.prepare("SELECT type, name FROM pois WHERE id = ?").bind(master!.poi_id).first() as { type: string; name: string };
    expect(poi.type).toBe('attraction');
    expect(poi.name).toBe('美麗海水族館');
  });

  it('Phase 2: PATCH /entries/:eid 不接受 poi_id（避免跨 trip 指向）', async () => {
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };
    // v2.29.0: trip_entries.poi_id DROPPED. master 從 trip_entry_pois 查。
    const before = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number }>();
    const originalPoiId = before!.poi_id;

    // poi_id 不在 ALLOWED_FIELDS，PATCH 視為沒有有效欄位 → 400
    expect((await api.request('PATCH', `/api/trips/trip-dn/entries/${entry.id}`, { as: OWNER, json: {
        poi_id: 99999,
      } })).status).toBe(400);

    // master poi_id 保持原值未被改動
    const after = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number }>();
    expect(after!.poi_id).toBe(originalPoiId);
  });

  it('Phase 2: PUT /days/:num 拒絕非法 poi_type → 400', async () => {
    expect((await api.request('PUT', '/api/trips/trip-dn/days/2', { as: OWNER, json: {
        date: '2026-04-02', dayOfWeek: '四', label: 'Day 2',
        timeline: [{ time: '10:00', name: 'bad type', poi_type: 'invalid_type' }],
      } })).status).toBe(400);
  });

  it('Phase 2: PUT /entries/:eid/poi-id 重掛到既有 POI（驗證存在）', async () => {
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };

    const newPoi = await db.prepare(
      "INSERT INTO pois (type, name, source) VALUES ('attraction', 'Admin Override POI', 'test') RETURNING id",
    ).first() as { id: number };

    const resp = await api.request('PUT', `/api/trips/trip-dn/entries/${entry.id}/poi-id`, { as: OWNER, json: {
        poiId: newPoi.id,
      } });
    expect(resp.status).toBe(200);

    // v2.29.0: trip_entries.poi_id DROPPED. master 從 trip_entry_pois 查。
    const row = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first() as { poi_id: number };
    expect(row.poi_id).toBe(newPoi.id);
  });

  // 轉 HTTP 邊界時 mutation 發現的缺口（拿掉 poi-id 的寫入權限檢查，原測試仍全綠），補上
  it('Phase 2: PUT /entries/:eid/poi-id 非行程成員 → 403，master 不變', async () => {
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };
    const before = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number }>();
    const target = await db.prepare(
      "INSERT INTO pois (type, name) VALUES ('attraction', 'Stranger-Target-POI') RETURNING id",
    ).first() as { id: number };

    const resp = await api.request('PUT', `/api/trips/trip-dn/entries/${entry.id}/poi-id`, {
      as: 'days-num-stranger@test.com',
      json: { poiId: target.id },
    });
    expect(resp.status).toBe(403);
    const after = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number }>();
    expect(after!.poi_id).toBe(before!.poi_id);
    await db.prepare('DELETE FROM pois WHERE id = ?').bind(target.id).run(); // 共用 D1，清掉自己建的 POI
  });

  it('Phase 2: PUT /entries/:eid/poi-id 拒絕不存在的 poiId → 404', async () => {
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };

    expect((await api.request('PUT', `/api/trips/trip-dn/entries/${entry.id}/poi-id`, { as: OWNER, json: {
        poiId: 99999,
      } })).status).toBe(404);
  });

  it('v2.27.0: PUT /entries/:eid/poi-id 阻擋 null 清空（per multi-POI invariant，要用 DELETE entry）', async () => {
    // v2.27.0 起每 entry 至少要有 1 master POI（trip_entry_pois sort_order=1 invariant）。
    // 清空 master 的正確路徑是 DELETE /entries/:eid 刪整個 entry，不是 PUT /poi-id null。
    // pre-v2.27.0 此分支事實上 unreachable（frontend 沒地方傳 null），現在 explicit 阻擋。
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };
    // v2.29.0: trip_entries.poi_id DROPPED. master 從 trip_entry_pois 查。
    const before = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number | null }>();
    const originalPoiId = before?.poi_id ?? null;

    expect((await api.request('PUT', `/api/trips/trip-dn/entries/${entry.id}/poi-id`, { as: OWNER, json: {
        poiId: null,
      } })).status).toBe(400);
    // master poi_id 不變
    const after = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number | null }>();
    expect(after?.poi_id ?? null).toBe(originalPoiId);
  });

  // Round 9 — PUT /poi-id OCC token coverage (round 7 backend 加 entryPoisVersion body field)
  it('v2.27.0: PUT /poi-id 帶 stale entryPoisVersion → 409 STALE_ENTRY', async () => {
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };
    // v2.29.0: trip_entries.poi_id DROPPED. master 從 trip_entry_pois 查。
    const before = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first<{ poi_id: number }>();
    const originalPoiId = before!.poi_id;
    const newPoi = await db.prepare(
      "INSERT INTO pois (type, name) VALUES ('attraction', 'R9-OCC-Stale-Target') RETURNING id",
    ).first() as { id: number };

    const resp = await api.request('PUT', `/api/trips/trip-dn/entries/${entry.id}/poi-id`, { as: OWNER, json: {
        poiId: newPoi.id,
        entryPoisVersion: '99999', // 故意 stale
      } });
    expect(resp.status).toBe(409);
    // master poi_id 不變
    const after = await db.prepare(
      'SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
    ).bind(entry.id).first() as { poi_id: number };
    expect(after.poi_id).toBe(originalPoiId);
  });

  it('v2.27.0: PUT /poi-id 帶正確 entryPoisVersion → 200 + bump version', async () => {
    const dayId = await getDayId(db, 'trip-dn', 3);
    const entry = await db.prepare(
      'SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1',
    ).bind(dayId).first() as { id: number };
    const v0 = await db.prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?').bind(entry.id).first<{ v: number }>();
    const newPoi = await db.prepare(
      "INSERT INTO pois (type, name) VALUES ('attraction', 'R9-OCC-OK-Target') RETURNING id",
    ).first() as { id: number };

    const resp = await api.request('PUT', `/api/trips/trip-dn/entries/${entry.id}/poi-id`, { as: OWNER, json: {
        poiId: newPoi.id,
        entryPoisVersion: String(v0!.v),
      } });
    expect(resp.status).toBe(200);
    const v1 = await db.prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?').bind(entry.id).first<{ v: number }>();
    expect(v1!.v).toBe(v0!.v + 1);
  });
});

// Round 4 fix adv-C5 / Codex F4 regression: PUT /days/:num batch1 DELETE FROM
// trip_entries cascades trip_entry_pois rows (FK ON DELETE CASCADE). Without the
// preservation snapshot+restore, every PUT silently destroyed all alternates.
describe('PUT /api/trips/:id/days/:num — v2.27.0 alternates preservation', () => {
  it('保留 alternates：當新 timeline entry 的 master POI 跟舊 entry 同 → alternates 還在', async () => {
    const TRIP = 'trip-dn-alt';
    await seed({ id: TRIP, days: 1 });
    const dayId = await getDayId(db, TRIP, 1);

    // Seed: 1 entry with master "Master-X" + 2 alternates "Alt-A", "Alt-B"
    const masterPoi = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Master-X', 'attraction') RETURNING id")
      .first<{ id: number }>();
    const altA = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Alt-A', 'attraction') RETURNING id")
      .first<{ id: number }>();
    const altB = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Alt-B', 'attraction') RETURNING id")
      .first<{ id: number }>();
    const entry = await db
      .prepare("INSERT INTO trip_entries (day_id, sort_order, start_time) VALUES (?, 1, '10:00') RETURNING id")
      .bind(dayId)
      .first<{ id: number }>();
    await db.batch([
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, masterPoi!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)').bind(entry!.id, altA!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 3)').bind(entry!.id, altB!.id),
    ]);

    // Sanity: 3 trip_entry_pois rows for this entry
    const before = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entry!.id)
      .first<{ c: number }>();
    expect(before!.c).toBe(3);

    // PUT /days/:num with same master POI title (find-or-create resolves to same row)
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-05-12',
        dayOfWeek: '二',
        label: 'Updated',
        timeline: [
          { time: '11:00', name: 'Master-X', poi_type: 'attraction' },
        ],
      } });
    expect(resp.status).toBe(200);

    // Verify: alternates Alt-A + Alt-B restored
    const newEntry = await db
      .prepare('SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1')
      .bind(dayId)
      .first<{ id: number }>();
    const rows = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order')
      .bind(newEntry!.id)
      .all<{ poi_id: number; sort_order: number }>();
    expect(rows.results.length).toBe(3);
    expect(rows.results[0]!.sort_order).toBe(1);
    expect(rows.results[0]!.poi_id).toBe(masterPoi!.id);
    const altPoiIds = rows.results.slice(1).map((r) => r.poi_id).sort();
    expect(altPoiIds).toEqual([altA!.id, altB!.id].sort());
  });

  // Round 5 regression — adversarial round 6 #1 + testing P0 #1:
  // 兩 OLD entries 共享同 master POI（例如「松屋」連續兩餐），各自有不同 alternates。
  // Round 4 的「key by master_poi_id」snapshot 策略會 collapse 兩個 snapshot 進同 key，
  // 重排後其中一個 entry 拿到對方的 alternates，另一個拿空。
  // Round 5 fix：per-OLD-entry snapshot + claim-once mapping，保證 entry order 對齊。
  it('保留 alternates：兩 entries 共享相同 master POI 時，各自 alternates 不互換', async () => {
    const TRIP = 'trip-dn-alt-shared';
    await seed({ id: TRIP, days: 1 });
    const dayId = await getDayId(db, TRIP, 1);

    // Seed: master 共享 "Matsuya"，entry-1 有 alts [Alt-A, Alt-B]，entry-2 有 alts [Alt-C, Alt-D]
    const sharedMaster = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Matsuya', 'restaurant') RETURNING id")
      .first<{ id: number }>();
    const altA = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Alt-A', 'restaurant') RETURNING id")
      .first<{ id: number }>();
    const altB = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Alt-B', 'restaurant') RETURNING id")
      .first<{ id: number }>();
    const altC = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Alt-C', 'restaurant') RETURNING id")
      .first<{ id: number }>();
    const altD = await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Alt-D', 'restaurant') RETURNING id")
      .first<{ id: number }>();

    const entry1 = await db
      .prepare("INSERT INTO trip_entries (day_id, sort_order, start_time) VALUES (?, 1, '08:00') RETURNING id")
      .bind(dayId)
      .first<{ id: number }>();
    const entry2 = await db
      .prepare("INSERT INTO trip_entries (day_id, sort_order, start_time) VALUES (?, 2, '18:00') RETURNING id")
      .bind(dayId)
      .first<{ id: number }>();
    await db.batch([
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry1!.id, sharedMaster!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)').bind(entry1!.id, altA!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 3)').bind(entry1!.id, altB!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry2!.id, sharedMaster!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)').bind(entry2!.id, altC!.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 3)').bind(entry2!.id, altD!.id),
    ]);

    // PUT /days/:num with two entries both pointing at Matsuya (same as before)
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-05-12',
        dayOfWeek: '二',
        label: 'Updated',
        timeline: [
          { time: '08:30', name: 'Matsuya', poi_type: 'restaurant' },
          { time: '19:00', name: 'Matsuya', poi_type: 'restaurant' },
        ],
      } });
    expect(resp.status).toBe(200);

    // 確認兩個新 entries 各自保留自己原本的 alternates，不互換
    const newEntries = await db
      .prepare('SELECT id, sort_order FROM trip_entries WHERE day_id = ? ORDER BY sort_order')
      .bind(dayId)
      .all<{ id: number; sort_order: number }>();
    expect(newEntries.results.length).toBe(2);

    const e1Rows = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order')
      .bind(newEntries.results[0]!.id)
      .all<{ poi_id: number; sort_order: number }>();
    const e2Rows = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order')
      .bind(newEntries.results[1]!.id)
      .all<{ poi_id: number; sort_order: number }>();

    // entry1 應該拿到 [Master, Alt-A, Alt-B]（依序）
    expect(e1Rows.results.map((r) => r.poi_id)).toEqual([sharedMaster!.id, altA!.id, altB!.id]);
    // entry2 應該拿到 [Master, Alt-C, Alt-D]（依序）— 不該變成 [Master, Alt-A, Alt-B] 也不該空
    expect(e2Rows.results.map((r) => r.poi_id)).toEqual([sharedMaster!.id, altC!.id, altD!.id]);
  });
});

// v2.30.x (migration 0065): Day-level OCC token on PUT /days/:num
describe('PUT /api/trips/:id/days/:num — v2.30.x Day-level OCC (migration 0065)', () => {
  it('GET response 含 version field（initial 0）', async () => {
    const TRIP = 'trip-dn-occ-get';
    await seed({ id: TRIP, days: 1 });
    const resp = await api.request('GET', `/api/trips/${TRIP}/days/1`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { version?: number };
    expect(body.version).toBe(0);
  });

  it('PUT 成功 bump version + response 帶 dayVersion=1', async () => {
    const TRIP = 'trip-dn-occ-bump';
    await seed({ id: TRIP, days: 1 });
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'Day 1',
        timeline: [],
      } });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { dayVersion?: number };
    expect(body.dayVersion).toBe(1);

    // DB row 也 bump
    const dayId = await getDayId(db, TRIP, 1);
    const row = await db.prepare('SELECT version FROM trip_days WHERE id = ?').bind(dayId).first<{ version: number }>();
    expect(row!.version).toBe(1);
  });

  it('PUT 帶 expectedDayVersion 配對成功 → 200 + dayVersion bumped', async () => {
    const TRIP = 'trip-dn-occ-match';
    await seed({ id: TRIP, days: 1 });
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'Day 1',
        timeline: [],
        expectedDayVersion: 0,
      } });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { dayVersion?: number };
    expect(body.dayVersion).toBe(1);
  });

  it('PUT 帶 expectedDayVersion 不符 → 409 STALE_ENTRY', async () => {
    const TRIP = 'trip-dn-occ-stale';
    await seed({ id: TRIP, days: 1 });
    // 先 bump 一次到 v=1
    await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01', dayOfWeek: '三', label: 'D1', timeline: [],
      } });

    // 現在 trip_days.version = 1，client 帶 expectedDayVersion: 0 (stale) → 409
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-02', dayOfWeek: '四', label: 'D1-new', timeline: [],
        expectedDayVersion: 0,
      } });
    expect(resp.status).toBe(409);
    const body = await resp.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('STALE_ENTRY');

    // DB 沒被覆寫（仍是第一次 PUT 的 label）
    const dayId = await getDayId(db, TRIP, 1);
    const row = await db.prepare('SELECT label, version FROM trip_days WHERE id = ?').bind(dayId).first<{ label: string; version: number }>();
    expect(row!.label).toBe('D1');
    expect(row!.version).toBe(1);
  });

  it('未帶 expectedDayVersion → backwards-compat 略過 OCC check（既有 client 不破）', async () => {
    const TRIP = 'trip-dn-occ-skip';
    await seed({ id: TRIP, days: 1 });
    // 先 bump 兩次讓 version=2
    for (let i = 0; i < 2; i++) {
      await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
          date: '2026-04-01', dayOfWeek: '三', label: `D1-${i}`, timeline: [],
        } });
    }

    // 不帶 expectedDayVersion，PUT 仍成功 → 不檢查
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01', dayOfWeek: '三', label: 'D1-bwc', timeline: [],
      } });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { dayVersion?: number };
    expect(body.dayVersion).toBe(3);
  });
});

describe('PUT /api/trips/:id/days/:num — migration 0078 entry note → master poi note', () => {
  it('name request 帶 note → 寫進 master trip_entry_pois.note（非 trip_entries）', async () => {
    const TRIP = 'trip-dn-note-titleonly';
    await seed({ id: TRIP, days: 1 });
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'D1',
        timeline: [
          { time: '09:00', name: '展望台', poi_type: 'attraction', note: '看夕陽最佳' },
        ],
      } });
    expect(resp.status).toBe(200);
    const dayId = await getDayId(db, TRIP, 1);
    const entry = await db.prepare('SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1').bind(dayId).first<{ id: number }>();
    const master = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entry!.id)
      .first<{ note: string | null }>();
    expect(master!.note).toBe('看夕陽最佳');
  });

  it('canonical-choices entry：entry-level note 但 master choice note 空 → master poi note = entry note', async () => {
    const TRIP = 'trip-dn-note-choices';
    await seed({ id: TRIP, days: 1 });
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'D1',
        timeline: [
          {
            time: '12:00',
            name: '午餐',
            note: '整體備註：靠海那側',
            stopPois: [
              { name: '海鮮丼A', type: 'restaurant' }, // master，無 per-POI note
              { name: '定食B', type: 'restaurant', note: '備選B備註' },
            ],
          },
        ],
      } });
    expect(resp.status).toBe(200);
    const dayId = await getDayId(db, TRIP, 1);
    const entry = await db.prepare('SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1').bind(dayId).first<{ id: number }>();
    const master = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entry!.id)
      .first<{ note: string | null }>();
    expect(master!.note).toBe('整體備註：靠海那側');
    // 備選 B 的 per-POI note 不受影響
    const alt = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 2')
      .bind(entry!.id)
      .first<{ note: string | null }>();
    expect(alt!.note).toBe('備選B備註');
  });

  it('canonical-choices entry：master choice 已有 per-POI note → 不被 entry note 覆蓋（保留 master choice note）', async () => {
    const TRIP = 'trip-dn-note-choices-keep';
    await seed({ id: TRIP, days: 1 });
    const resp = await api.request('PUT', `/api/trips/${TRIP}/days/1`, { as: OWNER, json: {
        date: '2026-04-01',
        dayOfWeek: '三',
        label: 'D1',
        timeline: [
          {
            time: '12:00',
            name: '午餐',
            note: '整體備註',
            stopPois: [
              { name: '海鮮丼A', type: 'restaurant', note: 'master自己的備註' },
            ],
          },
        ],
      } });
    expect(resp.status).toBe(200);
    const dayId = await getDayId(db, TRIP, 1);
    const entry = await db.prepare('SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order LIMIT 1').bind(dayId).first<{ id: number }>();
    const master = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entry!.id)
      .first<{ note: string | null }>();
    // master choice note 優先；entry-level note 不覆蓋（避免雙重備註污染既有 per-POI note）
    expect(master!.note).toBe('master自己的備註');
  });
});
