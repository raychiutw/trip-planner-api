/**
 * days / entries 路由組的契約測試：實際回應必須符合文件 schema（多出未宣告的欄位也算失敗），
 * 文件列出的每個狀態碼都要有真實請求觸發過（反過來，觸發過的狀態碼也都要寫進文件）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip, seedEntry, seedPoi, getDayId, seedHotelForDay, seedEntryAlternate } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { z } from '@hono/zod-openapi';
import { expectContract } from './support';
import { ApiError } from '../../src/schemas/common';
import * as S from '../../src/schemas/days-entries';

const OWNER = 'dx-owner@test.com';
const STRANGER = 'dx-stranger@test.com';
const ORIGIN = 'https://trip-planner-dby.pages.dev';

let db: D1Database;
let api: Api;
const T = '/api/trips/{id}';
/** 各寫入路由文件上的 body schema。 */
const BODIES: Record<string, z.ZodTypeAny> = {
  [`POST ${T}/days`]: S.DaysCreateBody,
  [`POST ${T}/days/shift`]: S.DaysShiftBody,
  [`PUT ${T}/days/{num}`]: S.DayReplaceBody,
  [`POST ${T}/days/{num}/entries`]: S.EntryCreateBody,
  [`PATCH ${T}/entries/batch`]: S.EntriesBatchBody,
  [`PATCH ${T}/entries/{eid}`]: S.EntryPatchBody,
  [`POST ${T}/entries/{eid}/alternates`]: S.AlternateAddBody,
  [`PATCH ${T}/entries/{eid}/alternates/reorder`]: S.AlternateReorderBody,
  [`POST ${T}/entries/{eid}/copy`]: S.EntryCopyBody,
  [`PATCH ${T}/entries/{eid}/master`]: S.EntryMasterBody,
  [`PUT ${T}/entries/{eid}/poi-id`]: S.PoiIdReplaceBody,
  [`PATCH ${T}/entries/{eid}/pois/{poiId}`]: S.EntryPoiPatchBody,
  [`POST ${T}/entries/{eid}/trip-pois`]: S.EntryTripPoiBody,
};
/** 路由 key（`METHOD /api/trips/{id}/...`）→ 實際觸發過的狀態碼。 */
const triggered = new Map<string, Set<number>>();

type Opts = { as?: string; bearer?: string; json?: unknown; anon?: boolean };
async function call(method: string, tmpl: string, path: string, opts: Opts = {}): Promise<{ status: number; body: any }> {
  const res = await api.request(method, path, {
    as: opts.as, bearer: opts.bearer, json: opts.json,
    headers: opts.anon ? { Origin: ORIGIN } : undefined,
  });
  const key = `${method} ${tmpl}`;
  // 成功的請求，送出的 body 也必須符合文件的 body schema（handler 接受 ⇒ 文件不可判定為不合法）
  const bodySchema = BODIES[key];
  if (bodySchema && opts.json !== undefined && res.status < 300) expectContract(bodySchema, opts.json);
  if (!triggered.has(key)) triggered.set(key, new Set());
  triggered.get(key)!.add(res.status);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
/** 驗證錯誤回應：狀態碼對、body 符合 ApiError、code 對。 */
function expectError(r: { status: number; body: unknown }, status: number, code?: string) {
  expect(r.status).toBe(status);
  expectContract(ApiError, r.body);
  if (code) expect((r.body as any).error.code).toBe(code);
}

async function mk(tag: string) {
  const id = `dx-${tag}`;
  await seedTrip(db, { id, owner: OWNER, days: 2, published: 0 });
  const d1 = await getDayId(db, id, 1);
  const d2 = await getDayId(db, id, 2);
  const p1 = await seedPoi(db, { name: `${tag} p1`, type: 'attraction' });
  const p2 = await seedPoi(db, { name: `${tag} p2`, type: 'restaurant' });
  const a1 = await seedPoi(db, { name: `${tag} a1`, type: 'attraction' });
  const a2 = await seedPoi(db, { name: `${tag} a2`, type: 'shopping' });
  const e1 = await seedEntry(db, d1, { sortOrder: 1, poiId: p1 });
  const e2 = await seedEntry(db, d1, { sortOrder: 2, poiId: p2 });
  await seedEntryAlternate(db, { entryId: e1, poiId: a1, sortOrder: 2 });
  await seedEntryAlternate(db, { entryId: e1, poiId: a2, sortOrder: 3 });
  // 沒有任何 POI 的 entry（測 MISSING_MASTER）
  const bare = await seedEntry(db, d2, { sortOrder: 1 });
  await db.prepare(
    `INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, computed_at, updated_at)
     VALUES (?, ?, ?, 'driving', 30, 1200, 'google', ?, ?)`,
  ).bind(id, e1, e2, Date.now(), Date.now()).run();
  const hotel = await seedPoi(db, { name: `${tag} hotel`, type: 'hotel' });
  const park = await seedPoi(db, { name: `${tag} park`, type: 'parking' });
  // 填滿可為 null 的欄位，讓非 null 的型別也被驗到
  await db.prepare(
    `UPDATE pois SET description='d', note='n', address='a', phone='p', email='e@x.com', website='https://x', hours='9-17', rating=4.5,
       category='c', lat=26.2, lng=127.7, country='JP', source='google', osm_id=1, osm_type='node', wikidata_id='Q1', cuisine='x',
       data_source='g', data_fetched_at=1, place_id='pid', status_reason='r', status_checked_at='2026-01-01', last_refreshed_at='2026-01-01', price='$$'
     WHERE id IN (?, ?)`,
  ).bind(hotel, p1).run();
  await db.prepare(`UPDATE trip_entry_pois SET description='d', note='n', reservation='r', reservation_url='https://r' WHERE entry_id = ? AND poi_id = ?`).bind(e1, p1).run();
  await seedHotelForDay(db, d1, hotel);
  await db.prepare(`INSERT INTO poi_relations (poi_id, related_poi_id, relation_type) VALUES (?, ?, 'parking')`).bind(hotel, park).run();
  return { id, d1, d2, p1, p2, a1, a2, e1, e2, bare, hotel };
}
const base = (id: string) => `/api/trips/${id}`;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: ORIGIN }) });
});
afterAll(disposeMiniflare);


describe('days', () => {
  it('GET /days 摘要與 ?all=1', async () => {
    const f = await mk('days-get');
    expectContract(S.DaysListQuery, { all: '1' });
    const sum = await call('GET', `${T}/days`, `${base(f.id)}/days`, { as: OWNER });
    expect(sum.status).toBe(200);
    expectContract(z.array(S.DaySummary), sum.body);
    expectContract(S.DaysListResponse, sum.body);
    const all = await call('GET', `${T}/days`, `${base(f.id)}/days?all=1`, { as: OWNER });
    expect(all.status).toBe(200);
    expectContract(z.array(S.DayFull), all.body);
    expectContract(S.DaysListResponse, all.body);
    // 確認有飯店、停車場、車程、備選（避免只驗到空結構）
    expect(all.body[0].hotel.parking.length).toBe(1);
    expect(all.body[0].timeline[0].travel).not.toBeNull();
    expect(all.body[0].timeline[0].alternates.length).toBe(2);
  });
  it('GET /days 匿名讀公開行程', async () => {
    await seedTrip(db, { id: 'dx-pub', owner: OWNER, days: 1, published: 1 });
    const r = await call('GET', `${T}/days`, `/api/trips/dx-pub/days`);
    expect(r.status).toBe(200);
    expectContract(S.DaysListResponse, r.body);
  });
  it('GET /days 錯誤', async () => {
    const f = await mk('days-get-err');
    expectError(await call('GET', `${T}/days`, `${base(f.id)}/days`, { bearer: 'bad' }), 401);
    expectError(await call('GET', `${T}/days`, `${base(f.id)}/days`, { as: STRANGER }), 403);
    expectError(await call('GET', `${T}/days`, `/api/trips/dx-nope/days`, { as: OWNER }), 404);
  });

  it('POST /days 三種位置', async () => {
    const f = await mk('days-post');
    for (const json of [{ position: 'end' }, { position: 'start' }, { position: 'insert', date: '2030-01-01' }]) {
      const r = await call('POST', `${T}/days`, `${base(f.id)}/days`, { as: OWNER, json });
      expect(r.status).toBe(200);
      expectContract(S.DayCreateResponse, r.body);
    }
    // 空行程新增第一天：date 為 null
    await seedTrip(db, { id: 'dx-empty', owner: OWNER, days: 1 });
    await db.prepare("DELETE FROM trip_days WHERE trip_id = 'dx-empty'").run();
    const e = await call('POST', `${T}/days`, `/api/trips/dx-empty/days`, { as: OWNER, json: { position: 'end' } });
    expectContract(S.DayCreateResponse, e.body);
    expect(e.body.day.date).toBeNull();
  });
  it('POST /days 錯誤', async () => {
    const f = await mk('days-post-err');
    expectError(await call('POST', `${T}/days`, `${base(f.id)}/days`, { as: OWNER, json: { position: 'nope' } }), 400);
    expectError(await call('POST', `${T}/days`, `${base(f.id)}/days`, { anon: true, json: { position: 'end' } }), 401);
    expectError(await call('POST', `${T}/days`, `${base(f.id)}/days`, { as: STRANGER, json: { position: 'end' } }), 403);
  });

  it('POST /days/shift', async () => {
    const f = await mk('days-shift');
    const r = await call('POST', `${T}/days/shift`, `${base(f.id)}/days/shift`, { as: OWNER, json: { startDate: '2031-05-01' } });
    expect(r.status).toBe(200);
    expectContract(S.DayShiftResponse, r.body);
    // 平移 0 天的分支也走同一個 schema
    const z = await call('POST', `${T}/days/shift`, `${base(f.id)}/days/shift`, { as: OWNER, json: { startDate: '2031-05-01' } });
    expectContract(S.DayShiftResponse, z.body);
  });
  it('POST /days/shift 錯誤', async () => {
    const f = await mk('days-shift-err');
    expectError(await call('POST', `${T}/days/shift`, `${base(f.id)}/days/shift`, { as: OWNER, json: { startDate: 'x' } }), 400);
    expectError(await call('POST', `${T}/days/shift`, `${base(f.id)}/days/shift`, { anon: true, json: { startDate: '2031-05-01' } }), 401);
    expectError(await call('POST', `${T}/days/shift`, `${base(f.id)}/days/shift`, { as: STRANGER, json: { startDate: '2031-05-01' } }), 403);
  });

  it('GET /days/:num', async () => {
    const f = await mk('daynum-get');
    const r = await call('GET', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: OWNER });
    expect(r.status).toBe(200);
    expectContract(S.DayFull, r.body);
    const empty = await call('GET', `${T}/days/{num}`, `${base(f.id)}/days/2`, { as: OWNER });
    expectContract(S.DayFull, empty.body);
  });
  it('GET /days/:num 錯誤', async () => {
    const f = await mk('daynum-get-err');
    expectError(await call('GET', `${T}/days/{num}`, `${base(f.id)}/days/1`, { bearer: 'bad' }), 401);
    expectError(await call('GET', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: STRANGER }), 403);
    expectError(await call('GET', `${T}/days/{num}`, `${base(f.id)}/days/99`, { as: OWNER }), 404);
  });

  const putBody = {
    date: '2030-02-01', dayOfWeek: '五', label: 'Day 1',
    hotel: { name: 'Put Hotel', lat: 26.2, lng: 127.7, category: 'hotel', price: '$$$', hours: '24h', parking: [{ name: 'Put Park' }] },
    timeline: [
      { name: 'Put Spot', start_time: '09:00', end_time: '10:00', note: 'n' },
      { stopPois: [{ name: 'Put Cafe', type: 'restaurant', category: 'ramen', reservation: '12:00', rating: 4, lat: 26.2, lng: 127.7 }, { name: 'Put Alt', type: 'shopping' }], time: '11:00-12:00' },
    ],
  };
  it('PUT /days/:num 整天覆寫', async () => {
    const f = await mk('daynum-put');
    const r = await call('PUT', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: OWNER, json: putBody });
    expect(r.status).toBe(200);
    expectContract(S.DayReplaceResponse, r.body);
    expectContract(S.DayReplaceBody, putBody);
    const got = await call('GET', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: OWNER });
    expectContract(S.DayFull, got.body);
    expect(got.body.timeline.length).toBe(2);
  });
  it('PUT /days/:num 錯誤', async () => {
    const f = await mk('daynum-put-err');
    expectError(await call('PUT', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: OWNER, json: { date: '2030-02-01', dayOfWeek: '五' } }), 400);
    expectError(await call('PUT', `${T}/days/{num}`, `${base(f.id)}/days/1`, { anon: true, json: putBody }), 401);
    expectError(await call('PUT', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: STRANGER, json: putBody }), 403);
    expectError(await call('PUT', `${T}/days/{num}`, `${base(f.id)}/days/99`, { as: OWNER, json: putBody }), 404);
    expectError(await call('PUT', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: OWNER, json: { ...putBody, expectedDayVersion: 999 } }), 409, 'STALE_ENTRY');
  });

  it('DELETE /days/:num', async () => {
    const f = await mk('daynum-del');
    const r = await call('DELETE', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: OWNER });
    expect(r.status).toBe(200);
    expectContract(S.DayDeleteResponse, r.body);
    expect(r.body.removedEntryCount).toBe(2);
  });
  it('DELETE /days/:num 錯誤', async () => {
    const f = await mk('daynum-del-err');
    expectError(await call('DELETE', `${T}/days/{num}`, `${base(f.id)}/days/abc`, { as: OWNER }), 400);
    expectError(await call('DELETE', `${T}/days/{num}`, `${base(f.id)}/days/1`, { anon: true }), 401);
    expectError(await call('DELETE', `${T}/days/{num}`, `${base(f.id)}/days/1`, { as: STRANGER }), 403);
    expectError(await call('DELETE', `${T}/days/{num}`, `${base(f.id)}/days/99`, { as: OWNER }), 404);
  });

  it('POST /days/:num/entries', async () => {
    const f = await mk('daynum-entries');
    const body = { name: 'New Spot', poi_type: 'restaurant', lat: 26.1, lng: 127.6, rating: 4.2, description: 'd', note: 'n', source: 'manual', start_time: '13:00', end_time: '14:00', sort_order: 5 };
    const legacyTime = await call('POST', `${T}/days/{num}/entries`, `${base(f.id)}/days/1/entries`, { as: OWNER, json: { name: 'Legacy Time', time: '15:00-16:00' } });
    expect(legacyTime.status).toBe(201);
    expect(legacyTime.body.startTime).toBe('15:00');
    expectContract(S.EntryCreateBody, body);
    const r = await call('POST', `${T}/days/{num}/entries`, `${base(f.id)}/days/1/entries`, { as: OWNER, json: body });
    expect(r.status).toBe(201);
    expectContract(S.EntryRow, r.body);
    const minimal = await call('POST', `${T}/days/{num}/entries`, `${base(f.id)}/days/2/entries`, { as: OWNER, json: { name: 'Min' } });
    expectContract(S.EntryRow, minimal.body);
  });
  it('POST /days/:num/entries 錯誤', async () => {
    const f = await mk('daynum-entries-err');
    const p = `${base(f.id)}/days/1/entries`;
    expectError(await call('POST', `${T}/days/{num}/entries`, p, { as: OWNER, json: {} }), 400);
    expectError(await call('POST', `${T}/days/{num}/entries`, p, { anon: true, json: { name: 'x' } }), 401);
    expectError(await call('POST', `${T}/days/{num}/entries`, p, { as: STRANGER, json: { name: 'x' } }), 403);
    expectError(await call('POST', `${T}/days/{num}/entries`, `${base(f.id)}/days/99/entries`, { as: OWNER, json: { name: 'x' } }), 404);
  });
});

describe('entries', () => {
  it('PATCH /entries/batch', async () => {
    const f = await mk('batch');
    const body = { updates: [{ id: f.e1, sort_order: 10, start_time: '08:00' }, { id: f.e2, sort_order: 11, day_id: f.d2, end_time: null }] };
    expectContract(S.EntriesBatchBody, body);
    const r = await call('PATCH', `${T}/entries/batch`, `${base(f.id)}/entries/batch`, { as: OWNER, json: body });
    expect(r.status).toBe(200);
    expectContract(S.EntriesBatchResponse, r.body);
  });
  it('PATCH /entries/batch 錯誤', async () => {
    const f = await mk('batch-err');
    const p = `${base(f.id)}/entries/batch`;
    expectError(await call('PATCH', `${T}/entries/batch`, p, { as: OWNER, json: { updates: [] } }), 400);
    expectError(await call('PATCH', `${T}/entries/batch`, p, { anon: true, json: { updates: [{ id: f.e1, sort_order: 1 }] } }), 401);
    expectError(await call('PATCH', `${T}/entries/batch`, p, { as: STRANGER, json: { updates: [{ id: f.e1, sort_order: 1 }] } }), 403);
    expectError(await call('PATCH', `${T}/entries/batch`, p, { as: OWNER, json: { updates: [{ id: 999999, sort_order: 1 }] } }), 404);
  });

  it('GET /entries/:eid', async () => {
    const f = await mk('eget');
    const r = await call('GET', `${T}/entries/{eid}`, `${base(f.id)}/entries/${f.e1}`, { as: OWNER });
    expect(r.status).toBe(200);
    expectContract(S.EntryDetail, r.body);
    expect(r.body.master).not.toBeNull();
    const bare = await call('GET', `${T}/entries/{eid}`, `${base(f.id)}/entries/${f.bare}`, { as: OWNER });
    expectContract(S.EntryDetail, bare.body);
    expect(bare.body.master).toBeNull();
  });
  it('GET /entries/:eid 錯誤', async () => {
    const f = await mk('eget-err');
    const p = `${base(f.id)}/entries/${f.e1}`;
    expectError(await call('GET', `${T}/entries/{eid}`, `${base(f.id)}/entries/abc`, { as: OWNER }), 400);
    expectError(await call('GET', `${T}/entries/{eid}`, p, { bearer: 'bad' }), 401);
    expectError(await call('GET', `${T}/entries/{eid}`, p, { as: STRANGER }), 403);
    expectError(await call('GET', `${T}/entries/{eid}`, `${base(f.id)}/entries/999999`, { as: OWNER }), 404);
  });

  it('PATCH /entries/:eid', async () => {
    const f = await mk('epatch');
    const p = `${base(f.id)}/entries/${f.e1}`;
    const body = { start_time: '09:00', end_time: '10:00', description: 'x', source: 'manual', expectedVersion: 0 };
    expectContract(S.EntryPatchBody, body);
    const r = await call('PATCH', `${T}/entries/{eid}`, p, { as: OWNER, json: body });
    expect(r.status).toBe(200);
    expectContract(S.EntryRow, r.body);
    const cleared = await call('PATCH', `${T}/entries/{eid}`, p, { as: OWNER, json: { start_time: null, end_time: null, description: null } });
    expectContract(S.EntryRow, cleared.body);
    expect(cleared.body.startTime).toBeNull();
    const legacy = await call('PATCH', `${T}/entries/{eid}`, p, { as: OWNER, json: { time: '11:00-12:00' } });
    expect(legacy.body.startTime).toBe('11:00');
    expect(legacy.body.endTime).toBe('12:00');
  });
  it('PATCH /entries/:eid 錯誤', async () => {
    const f = await mk('epatch-err');
    const p = `${base(f.id)}/entries/${f.e1}`;
    expectError(await call('PATCH', `${T}/entries/{eid}`, p, { as: OWNER, json: { day_id: -1 } }), 400);
    expectError(await call('PATCH', `${T}/entries/{eid}`, p, { anon: true, json: { description: 'x' } }), 401);
    expectError(await call('PATCH', `${T}/entries/{eid}`, p, { as: STRANGER, json: { description: 'x' } }), 403);
    expectError(await call('PATCH', `${T}/entries/{eid}`, `${base(f.id)}/entries/999999`, { as: OWNER, json: { description: 'x' } }), 404);
    expectError(await call('PATCH', `${T}/entries/{eid}`, p, { as: OWNER, json: { description: 'x', expectedVersion: 999 } }), 409, 'STALE_ENTRY');
  });

  it('DELETE /entries/:eid', async () => {
    const f = await mk('edel');
    const r = await call('DELETE', `${T}/entries/{eid}`, `${base(f.id)}/entries/${f.e2}`, { as: OWNER });
    expect(r.status).toBe(200);
    expectContract(S.Ok, r.body);
  });
  it('DELETE /entries/:eid 錯誤', async () => {
    const f = await mk('edel-err');
    const p = `${base(f.id)}/entries/${f.e2}`;
    expectError(await call('DELETE', `${T}/entries/{eid}`, `${base(f.id)}/entries/abc`, { as: OWNER }), 400);
    expectError(await call('DELETE', `${T}/entries/{eid}`, p, { anon: true }), 401);
    expectError(await call('DELETE', `${T}/entries/{eid}`, p, { as: STRANGER }), 403);
    expectError(await call('DELETE', `${T}/entries/{eid}`, `${base(f.id)}/entries/999999`, { as: OWNER }), 404);
  });
});

describe('alternates / master / poi-id / pois / trip-pois / copy', () => {
  const ALT = `${T}/entries/{eid}/alternates`;

  it('POST /alternates（poiId 與 find-or-create 兩種）', async () => {
    const f = await mk('alt-post');
    const extra = await seedPoi(db, { name: 'alt extra', type: 'attraction' });
    const p = `${base(f.id)}/entries/${f.e2}/alternates`;
    const r = await call('POST', ALT, p, { as: OWNER, json: { poiId: extra, entryPoisVersion: '0' } });
    expect(r.status).toBe(201);
    expectContract(S.AlternateAddResponse, r.body);
    const body = { name: 'Searched Place', lat: 26.3, lng: 127.8, type: 'attraction', category: 'cafe', address: '那霸市牧志 1-1', rating: 4.1, country: 'JP', source: 'google' };
    expectContract(S.AlternateAddBody, body);
    const r2 = await call('POST', ALT, p, { as: OWNER, json: body });
    expect(r2.status).toBe(201);
    expectContract(S.AlternateAddResponse, r2.body);
  });
  it('POST /alternates 錯誤', async () => {
    const f = await mk('alt-post-err');
    const p = `${base(f.id)}/entries/${f.e1}/alternates`;
    expectError(await call('POST', ALT, p, { as: OWNER, json: {} }), 400);
    expectError(await call('POST', ALT, `${base(f.id)}/entries/${f.bare}/alternates`, { as: OWNER, json: { poiId: f.p2 } }), 400, 'MISSING_MASTER');
    expectError(await call('POST', ALT, p, { anon: true, json: { poiId: f.p2 } }), 401);
    expectError(await call('POST', ALT, p, { as: STRANGER, json: { poiId: f.p2 } }), 403);
    expectError(await call('POST', ALT, `${base(f.id)}/entries/999999/alternates`, { as: OWNER, json: { poiId: f.p2 } }), 404);
    expectError(await call('POST', ALT, p, { as: OWNER, json: { poiId: f.a1 } }), 409, 'DUPLICATE_POI');
    expectError(await call('POST', ALT, p, { as: OWNER, json: { poiId: f.p2, entryPoisVersion: '999' } }), 409, 'STALE_ENTRY');
  });

  const REORDER = `${T}/entries/{eid}/alternates/reorder`;
  it('PATCH /alternates/reorder', async () => {
    const f = await mk('alt-reorder');
    const body = { order: [f.a2, f.a1], entryPoisVersion: '0' };
    expectContract(S.AlternateReorderBody, body);
    const r = await call('PATCH', REORDER, `${base(f.id)}/entries/${f.e1}/alternates/reorder`, { as: OWNER, json: body });
    expect(r.status).toBe(200);
    expectContract(S.AlternateReorderResponse, r.body);
  });
  it('PATCH /alternates/reorder 錯誤', async () => {
    const f = await mk('alt-reorder-err');
    const p = `${base(f.id)}/entries/${f.e1}/alternates/reorder`;
    expectError(await call('PATCH', REORDER, `${base(f.id)}/entries/abc/alternates/reorder`, { as: OWNER, json: { order: [] } }), 400);
    expectError(await call('PATCH', REORDER, p, { anon: true, json: { order: [] } }), 401);
    expectError(await call('PATCH', REORDER, p, { as: STRANGER, json: { order: [] } }), 403);
    expectError(await call('PATCH', REORDER, `${base(f.id)}/entries/999999/alternates/reorder`, { as: OWNER, json: { order: [] } }), 404);
    expectError(await call('PATCH', REORDER, p, { as: OWNER, json: { order: [f.a1, f.a2], entryPoisVersion: '999' } }), 409, 'STALE_ENTRY');
    expectError(await call('PATCH', REORDER, p, { as: OWNER, json: { order: [f.a1] } }), 422, 'INVALID_ORDER');
  });

  const ALT_DEL = `${T}/entries/{eid}/alternates/{poiId}`;
  it('DELETE /alternates/:poiId', async () => {
    const f = await mk('alt-del');
    const r = await call('DELETE', ALT_DEL, `${base(f.id)}/entries/${f.e1}/alternates/${f.a1}`, { as: OWNER });
    expect(r.status).toBe(200);
    expectContract(S.AlternateRemoveResponse, r.body);
    const q = await call('DELETE', ALT_DEL, `${base(f.id)}/entries/${f.e1}/alternates/${f.a2}?entryPoisVersion=${r.body.entryPoisVersion}`, { as: OWNER });
    expectContract(S.AlternateRemoveResponse, q.body);
    expectContract(S.AlternateDeleteQuery, { entryPoisVersion: r.body.entryPoisVersion });
  });
  it('DELETE /alternates/:poiId 錯誤', async () => {
    const f = await mk('alt-del-err');
    const p = `${base(f.id)}/entries/${f.e1}/alternates/${f.a1}`;
    expectError(await call('DELETE', ALT_DEL, `${base(f.id)}/entries/${f.e1}/alternates/${f.p1}`, { as: OWNER }), 400);
    expectError(await call('DELETE', ALT_DEL, p, { anon: true }), 401);
    expectError(await call('DELETE', ALT_DEL, p, { as: STRANGER }), 403);
    expectError(await call('DELETE', ALT_DEL, `${base(f.id)}/entries/${f.e1}/alternates/999999`, { as: OWNER }), 404, 'POI_NOT_ALTERNATE');
    expectError(await call('DELETE', ALT_DEL, `${p}?entryPoisVersion=999`, { as: OWNER }), 409, 'STALE_ENTRY');
  });

  const COPY = `${T}/entries/{eid}/copy`;
  it('POST /copy', async () => {
    const f = await mk('copy');
    const body = { targetDayId: f.d2, sortOrder: 7, time: '10:00-11:00' };
    expectContract(S.EntryCopyBody, body);
    const r = await call('POST', COPY, `${base(f.id)}/entries/${f.e1}/copy`, { as: OWNER, json: body });
    expect(r.status).toBe(200);
    expectContract(S.EntryRow, r.body);
    const r2 = await call('POST', COPY, `${base(f.id)}/entries/${f.e1}/copy`, { as: OWNER, json: { targetDayId: f.d1 } });
    expectContract(S.EntryRow, r2.body);
  });
  it('POST /copy 錯誤', async () => {
    const f = await mk('copy-err');
    const p = `${base(f.id)}/entries/${f.e1}/copy`;
    expectError(await call('POST', COPY, p, { as: OWNER, json: {} }), 400);
    expectError(await call('POST', COPY, p, { anon: true, json: { targetDayId: f.d2 } }), 401);
    expectError(await call('POST', COPY, p, { as: STRANGER, json: { targetDayId: f.d2 } }), 403);
    expectError(await call('POST', COPY, p, { as: OWNER, json: { targetDayId: 999999 } }), 404);
  });

  const MASTER = `${T}/entries/{eid}/master`;
  it('PATCH /master', async () => {
    const f = await mk('master');
    const p = `${base(f.id)}/entries/${f.e1}/master`;
    const r = await call('PATCH', MASTER, p, { as: OWNER, json: { poiId: f.a1, entryPoisVersion: '0' } });
    expect(r.status).toBe(200);
    expectContract(S.EntryMasterResponse, r.body);
    expectContract(S.EntryMasterBody, { poiId: f.a1, version: '1' });
    // 沒有正選的 entry：oldMasterPoiId 為 null
    const b = await call('PATCH', MASTER, `${base(f.id)}/entries/${f.bare}/master`, { as: OWNER, json: { poiId: f.p1 } });
    expectContract(S.EntryMasterResponse, b.body);
    expect(b.body.oldMasterPoiId).toBeNull();
  });
  it('PATCH /master 錯誤', async () => {
    const f = await mk('master-err');
    const p = `${base(f.id)}/entries/${f.e1}/master`;
    expectError(await call('PATCH', MASTER, p, { as: OWNER, json: {} }), 400);
    expectError(await call('PATCH', MASTER, p, { anon: true, json: { poiId: f.a1 } }), 401);
    expectError(await call('PATCH', MASTER, p, { as: STRANGER, json: { poiId: f.a1 } }), 403);
    expectError(await call('PATCH', MASTER, p, { as: OWNER, json: { poiId: 999999 } }), 404);
    expectError(await call('PATCH', MASTER, p, { as: OWNER, json: { poiId: f.a1, entryPoisVersion: '999' } }), 409, 'STALE_ENTRY');
  });

  const POIID = `${T}/entries/{eid}/poi-id`;
  it('PUT /poi-id（poiId 與 find-or-create 兩種）', async () => {
    const f = await mk('poiid');
    const p = `${base(f.id)}/entries/${f.e1}/poi-id`;
    const r = await call('PUT', POIID, p, { as: OWNER, json: { poiId: f.p2 } });
    expect(r.status).toBe(200);
    expectContract(S.PoiIdReplaceResponse, r.body);
    const body = { name: 'PoiId Place', lat: 26.4, lng: 127.9, type: 'attraction', category: 'cafe', address: '那霸市松山 2-2', rating: 3.9, country: 'JP', source: 'google' };
    expectContract(S.PoiIdReplaceBody, body);
    const r2 = await call('PUT', POIID, p, { as: OWNER, json: body });
    expectContract(S.PoiIdReplaceResponse, r2.body);
  });
  it('PUT /poi-id 錯誤', async () => {
    const f = await mk('poiid-err');
    const p = `${base(f.id)}/entries/${f.e1}/poi-id`;
    expectError(await call('PUT', POIID, p, { as: OWNER, json: {} }), 400);
    expectError(await call('PUT', POIID, p, { anon: true, json: { poiId: f.p2 } }), 401);
    expectError(await call('PUT', POIID, p, { as: STRANGER, json: { poiId: f.p2 } }), 403);
    expectError(await call('PUT', POIID, p, { as: OWNER, json: { poiId: 999999 } }), 404);
    expectError(await call('PUT', POIID, p, { as: OWNER, json: { poiId: f.p2, entryPoisVersion: '999' } }), 409, 'STALE_ENTRY');
  });

  const POIS = `${T}/entries/{eid}/pois/{poiId}`;
  it('PATCH /pois/:poiId', async () => {
    const f = await mk('pois');
    const p = `${base(f.id)}/entries/${f.e1}/pois/${f.p1}`;
    const body = { note: '備註', reservation: '19:00 兩位' };
    expectContract(S.EntryPoiPatchBody, body);
    const r = await call('PATCH', POIS, p, { as: OWNER, json: body });
    expect(r.status).toBe(200);
    expectContract(S.EntryPoiPatchResponse, r.body);
    const t = await call('PATCH', POIS, p, { as: OWNER, json: { poi_type: 'restaurant', note: null, reservation: null } });
    expectContract(S.EntryPoiPatchResponse, t.body);
    expect(t.body.note).toBeNull();
  });
  it('PATCH /pois/:poiId 錯誤', async () => {
    const f = await mk('pois-err');
    const p = `${base(f.id)}/entries/${f.e1}/pois/${f.p1}`;
    expectError(await call('PATCH', POIS, p, { as: OWNER, json: {} }), 400);
    expectError(await call('PATCH', POIS, p, { anon: true, json: { note: 'x' } }), 401);
    expectError(await call('PATCH', POIS, p, { as: STRANGER, json: { note: 'x' } }), 403);
    expectError(await call('PATCH', POIS, `${base(f.id)}/entries/${f.e1}/pois/999999`, { as: OWNER, json: { note: 'x' } }), 404);
  });

  const TRIPPOIS = `${T}/entries/{eid}/trip-pois`;
  it('POST /trip-pois', async () => {
    const f = await mk('trippois');
    const body = { name: 'Trip Poi', type: 'shopping', description: 'd', note: 'n', hours: '10-20', rating: 4, category: 'x', lat: 26.5, lng: 127.5, price: '$$', reservation: 'r', reservation_url: 'https://e.com' };
    expectContract(S.EntryTripPoiBody, body);
    const r = await call('POST', TRIPPOIS, `${base(f.id)}/entries/${f.e1}/trip-pois`, { as: OWNER, json: body });
    expect(r.status).toBe(201);
    expectContract(S.EntryPoiRow, r.body);
    const m = await call('POST', TRIPPOIS, `${base(f.id)}/entries/${f.e1}/trip-pois`, { as: OWNER, json: { name: 'Minimal', type: 'other' } });
    expectContract(S.EntryPoiRow, m.body);
  });
  it('POST /trip-pois 錯誤', async () => {
    const f = await mk('trippois-err');
    const p = `${base(f.id)}/entries/${f.e1}/trip-pois`;
    expectError(await call('POST', TRIPPOIS, p, { as: OWNER, json: { name: 'x' } }), 400);
    expectError(await call('POST', TRIPPOIS, p, { anon: true, json: { name: 'x', type: 'other' } }), 401);
    expectError(await call('POST', TRIPPOIS, p, { as: STRANGER, json: { name: 'x', type: 'other' } }), 403);
    // 同名同類 → 找到既有 POI → 已在此 entry
    expectError(await call('POST', TRIPPOIS, p, { as: OWNER, json: { name: `${'trippois-err'} p1`, type: 'attraction' } }), 409);
  });
});


describe('handler 拒絕的 body，文件的 body schema 也判定不合法', () => {
  const reject = (schema: z.ZodTypeAny, body: unknown) => {
    // 用一般 parse（strictify 會丟掉陣列的 .min）
    expect(schema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  };
  it('逐一對照', async () => {
    const f = await mk('reject');
    const b = base(f.id);
    const pairs: Array<[string, string, string, z.ZodTypeAny, unknown]> = [
      ['POST', `${T}/days`, `${b}/days`, S.DaysCreateBody, { position: 'nope' }],
      ['POST', `${T}/days/shift`, `${b}/days/shift`, S.DaysShiftBody, { startDate: 'x' }],
      ['PUT', `${T}/days/{num}`, `${b}/days/1`, S.DayReplaceBody, { date: '2030-02-01', dayOfWeek: '五' }],
      ['POST', `${T}/days/{num}/entries`, `${b}/days/1/entries`, S.EntryCreateBody, {}],
      ['PATCH', `${T}/entries/batch`, `${b}/entries/batch`, S.EntriesBatchBody, { updates: [] }],
      ['PATCH', `${T}/entries/{eid}`, `${b}/entries/${f.e1}`, S.EntryPatchBody, { day_id: -1 }],
      ['PATCH', `${T}/entries/{eid}/alternates/reorder`, `${b}/entries/${f.e1}/alternates/reorder`, S.AlternateReorderBody, { order: 'x' }],
      ['POST', `${T}/entries/{eid}/copy`, `${b}/entries/${f.e1}/copy`, S.EntryCopyBody, {}],
      ['PATCH', `${T}/entries/{eid}/master`, `${b}/entries/${f.e1}/master`, S.EntryMasterBody, {}],
      ['POST', `${T}/entries/{eid}/trip-pois`, `${b}/entries/${f.e1}/trip-pois`, S.EntryTripPoiBody, { name: 'x' }],
    ];
    for (const [m, tmpl, path, schema, body] of pairs) {
      const r = await call(m, tmpl, path, { as: OWNER, json: body });
      expect(r.status, `${m} ${tmpl}`).toBe(tmpl.endsWith('/reorder') ? 422 : 400);
      reject(schema, body);
    }
  });
});

describe('OpenAPI 文件', () => {
  const ROUTES: Array<{ key: string; auth: 'required' | 'optional'; body: boolean }> = [
    { key: `GET ${T}/days`, auth: 'optional', body: false },
    { key: `POST ${T}/days`, auth: 'required', body: true },
    { key: `POST ${T}/days/shift`, auth: 'required', body: true },
    { key: `GET ${T}/days/{num}`, auth: 'optional', body: false },
    { key: `PUT ${T}/days/{num}`, auth: 'required', body: true },
    { key: `DELETE ${T}/days/{num}`, auth: 'required', body: false },
    { key: `POST ${T}/days/{num}/entries`, auth: 'required', body: true },
    { key: `PATCH ${T}/entries/batch`, auth: 'required', body: true },
    { key: `GET ${T}/entries/{eid}`, auth: 'optional', body: false },
    { key: `PATCH ${T}/entries/{eid}`, auth: 'required', body: true },
    { key: `DELETE ${T}/entries/{eid}`, auth: 'required', body: false },
    { key: `POST ${T}/entries/{eid}/alternates`, auth: 'required', body: true },
    { key: `PATCH ${T}/entries/{eid}/alternates/reorder`, auth: 'required', body: true },
    { key: `DELETE ${T}/entries/{eid}/alternates/{poiId}`, auth: 'required', body: false },
    { key: `POST ${T}/entries/{eid}/copy`, auth: 'required', body: true },
    { key: `PATCH ${T}/entries/{eid}/master`, auth: 'required', body: true },
    { key: `PUT ${T}/entries/{eid}/poi-id`, auth: 'required', body: true },
    { key: `PATCH ${T}/entries/{eid}/pois/{poiId}`, auth: 'required', body: true },
    { key: `POST ${T}/entries/{eid}/trip-pois`, auth: 'required', body: true },
  ];
  let spec: any;
  beforeAll(async () => { spec = await (await api.get('/openapi.json')).json(); });

  const op = (key: string) => { const [m, p] = key.split(' '); return spec.paths?.[p!]?.[m!.toLowerCase()]; };

  it('每一條路由都有寫文件：requestBody／responses／security 與 auth 模式一致', () => {
    for (const r of ROUTES) {
      const o = op(r.key);
      expect(o, `${r.key} 不在 /openapi.json`).toBeTruthy();
      if (r.body) expect(o.requestBody?.content?.['application/json']?.schema, `${r.key} 缺 requestBody`).toBeTruthy();
      const res = Object.values(o.responses ?? {}) as any[];
      expect(res.some((x) => x.content?.['application/json']?.schema), `${r.key} 沒有任何有 schema 的回應`).toBe(true);
      // 預設的「200 任意內容」不算（z.any() 轉出來是空 schema）
      const succ = Object.entries(o.responses ?? {}).find(([c]) => c.startsWith('2'));
      expect(succ, `${r.key} 沒有成功狀態碼`).toBeTruthy();
      const schema = (succ![1] as any).content?.['application/json']?.schema;
      expect(schema && Object.keys(schema).length > 0, `${r.key} 成功回應 schema 是空的`).toBe(true);
      expect(o.security).toEqual(r.auth === 'required' ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}]);
      expect(res.length).toBeGreaterThan(1); // 至少一個錯誤碼
    }
  });

  it('文件列出的狀態碼都被真實請求觸發過，觸發過的也都有寫進文件', () => {
    for (const r of ROUTES) {
      const documented = Object.keys(op(r.key).responses ?? {}).map(Number).sort((a, b) => a - b);
      const seen = [...(triggered.get(r.key) ?? [])].sort((a, b) => a - b);
      expect(documented, r.key).toEqual(seen);
    }
  });

  it('文件裡的每個錯誤回應都引用 ApiError', () => {
    for (const r of ROUTES) {
      for (const [code, v] of Object.entries(op(r.key).responses ?? {}) as Array<[string, any]>) {
        if (Number(code) < 400) continue;
        expect(JSON.stringify(v.content?.['application/json']?.schema), `${r.key} ${code}`).toContain('ApiError');
      }
    }
  });
});
