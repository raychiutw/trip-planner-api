/**
 * Integration test — v2.34.39 PR39 (PR35 P1 gap)
 *
 * 涵蓋兩個 endpoint:
 *   - POST /api/pois/find-or-create — POI master 入庫 + dedup
 *   - POST /api/trips/:id/entries/:eid/trip-pois — entry alternate POI（含 audit_log）
 *
 * 對齊 PR32 trip mutation audit_log + PR35 doc 標 P1 MEDIUM gap。
 *
 * 走 HTTP 邊界（tests/api/http.ts），認證用真實 bearer token，斷言落在 Response 與真實 D1 的資料變化。
 * 共用 D1：專屬 trip／email，POI 名稱一律 `s10-pr39` 前綴（pois 的 name+type 唯一約束跨檔會衝突），結束時清掉。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const ownerEmail = 's10-pr39-owner@example.test';
const strangerEmail = 's10-pr39-stranger@example.test';
const tripId = 's10-pr39-trip';
const otherTripId = 's10-pr39-other-trip';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
  await seedTrip(db, { id: tripId, owner: ownerEmail });
  await seedTrip(db, { id: otherTripId, owner: ownerEmail });
});

afterAll(async () => {
  await db.prepare('DELETE FROM audit_log WHERE trip_id IN (?, ?)').bind(tripId, otherTripId).run();
  await cleanupTrips(db, ['s10-pr39-%'], ['s10-pr39%']);
  await db.prepare('DELETE FROM users WHERE email LIKE ?').bind('s10-pr39-%').run();
  await disposeMiniflare();
});

describe('POST /api/pois/find-or-create — PR39', () => {
  const callFindOrCreate = (body: Record<string, unknown>, email = ownerEmail) =>
    api.request('POST', '/api/pois/find-or-create', { as: email, json: body });
  const countPois = async (name: string, type: string) =>
    (await db.prepare('SELECT COUNT(*) AS c FROM pois WHERE name = ? AND type = ?').bind(name, type).first<{ c: number }>())!.c;

  it('未認證 → 401，且不建立 POI', async () => {
    const res = await api.request('POST', '/api/pois/find-or-create', {
      json: { name: 's10-pr39 anon 店', type: 'restaurant' },
      headers: { Origin: 'https://trip-planner-dby.pages.dev' },
    });
    expect(res.status).toBe(401);
    expect(await countPois('s10-pr39 anon 店', 'restaurant')).toBe(0);
  });

  it('缺 name → 400 DATA_VALIDATION', async () => {
    const res = await callFindOrCreate({ type: 'restaurant' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
    expect(body.error.detail).toContain('name');
  });

  it('缺 type → 400 DATA_VALIDATION', async () => {
    const res = await callFindOrCreate({ name: 's10-pr39 Foo' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.detail).toContain('type');
    expect(await countPois('s10-pr39 Foo', 'restaurant')).toBe(0);
  });

  it('name trim 空字串 → 400', async () => {
    const res = await callFindOrCreate({ name: '   ', type: 'restaurant' });
    expect(res.status).toBe(400);
  });

  it('正常 POST → 200 + id (newly created in pois table)', async () => {
    const res = await callFindOrCreate({
      name: 's10-pr39 拉麵店',
      type: 'restaurant',
      lat: 35.6,
      lng: 139.7,
      address: '東京都新宿区',
      place_id: 'ChIJ_s10_pr39',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: number };
    expect(body.id).toBeGreaterThan(0);
    const row = await db.prepare('SELECT name, type, lat, lng, address, place_id, source FROM pois WHERE id = ?')
      .bind(body.id).first<Record<string, unknown>>();
    expect(row).toEqual({
      name: 's10-pr39 拉麵店', type: 'restaurant', lat: 35.6, lng: 139.7,
      address: '東京都新宿区', place_id: 'ChIJ_s10_pr39', source: 'user-explore',
    });
  });

  it('name／type 前後空白會被 trim 後才入庫', async () => {
    const res = await callFindOrCreate({ name: '  s10-pr39 trim 店  ', type: ' restaurant ' });
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: number };
    const row = await db.prepare('SELECT name, type FROM pois WHERE id = ?').bind(id).first<{ name: string; type: string }>();
    expect(row).toEqual({ name: 's10-pr39 trim 店', type: 'restaurant' });
  });

  it('重複 POST same name+type → 同 id (dedup via findOrCreatePoi)，pois 只有一列', async () => {
    const first = await callFindOrCreate({ name: 's10-pr39 dedup 店', type: 'restaurant' });
    const a = await first.json() as { id: number };
    const second = await callFindOrCreate({ name: 's10-pr39 dedup 店', type: 'restaurant' });
    const b = await second.json() as { id: number };
    expect(b.id).toBe(a.id);
    expect(await countPois('s10-pr39 dedup 店', 'restaurant')).toBe(1);
  });

  it('既有 POI 再 POST：只補 NULL 欄位，不覆蓋已有的值（fill-null）', async () => {
    const first = await callFindOrCreate({ name: 's10-pr39 fill 店', type: 'restaurant', address: '原本的地址' });
    const { id } = await first.json() as { id: number };
    const again = await callFindOrCreate({
      name: 's10-pr39 fill 店', type: 'restaurant', address: '想覆蓋的地址', lat: 1.5, lng: 2.5,
    });
    expect(((await again.json()) as { id: number }).id).toBe(id);
    const row = await db.prepare('SELECT address, lat, lng FROM pois WHERE id = ?').bind(id).first<Record<string, unknown>>();
    expect(row).toEqual({ address: '原本的地址', lat: 1.5, lng: 2.5 });
  });

  it('同名但 type 不同 → 視為不同 POI', async () => {
    const a = await (await callFindOrCreate({ name: 's10-pr39 兩用店', type: 'restaurant' })).json() as { id: number };
    const b = await (await callFindOrCreate({ name: 's10-pr39 兩用店', type: 'shopping' })).json() as { id: number };
    expect(b.id).not.toBe(a.id);
  });
});

// 依賴 trips／entry-pois 組的 /api/trips/:id/entries/:eid/trip-pois 路由（不在本組，此處尚未登記）
describe.skip('POST /api/trips/:id/entries/:eid/trip-pois — PR39', () => {
  let dayId: number;
  let entryId: number;

  beforeAll(async () => {
    dayId = await getDayId(db, tripId, 1);
    entryId = await seedEntry(db, dayId, { sortOrder: 1 });
  });

  const callAddPoi = (body: Record<string, unknown>, eidOverride: string | number = entryId, email = ownerEmail, trip = tripId) =>
    api.request('POST', `/api/trips/${trip}/entries/${eidOverride}/trip-pois`, { as: email, json: body });

  it('entry id 格式錯（非數字）→ 400 DATA_VALIDATION', async () => {
    const res = await callAddPoi({ name: 's10-pr39 x', type: 'restaurant' }, 'abc');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.detail).toContain('entry');
  });

  it('沒 write perm（stranger）→ 403 PERM_DENIED，且不建立 POI 或關聯', async () => {
    const res = await callAddPoi({ name: 's10-pr39 stranger POI', type: 'restaurant' }, entryId, strangerEmail);
    expect(res.status).toBe(403);
    const poi = await db.prepare('SELECT id FROM pois WHERE name = ?').bind('s10-pr39 stranger POI').first();
    expect(poi).toBeNull();
  });

  it('entry 不屬於該 trip → 403', async () => {
    const otherEntry = await seedEntry(db, await getDayId(db, otherTripId, 1), { sortOrder: 1 });
    const res = await callAddPoi({ name: 's10-pr39 cross-trip POI', type: 'restaurant' }, otherEntry);
    expect(res.status).toBe(403);
    const links = await db.prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?').bind(otherEntry).first<{ c: number }>();
    expect(links!.c).toBe(0);
  });

  it('缺 name / type → 400 DATA_VALIDATION', async () => {
    const res = await callAddPoi({ name: 's10-pr39 only-name' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.detail).toContain('name');
  });

  it('正常 POST → 201 + result row + entry_pois_version 加 1 + audit_log 寫入', async () => {
    const before = await db.prepare('SELECT entry_pois_version FROM trip_entries WHERE id = ?').bind(entryId).first<{ entry_pois_version: number }>();

    const res = await callAddPoi({
      name: 's10-pr39 entry POI',
      type: 'restaurant',
      lat: 35.6,
      lng: 139.7,
      note: 'happy hour',
    });
    expect(res.status).toBe(201);
    // json() helper auto-deepCamel → snake_case keys → camelCase
    const row = await res.json() as { id: number; entryId: number; poiId: number; sortOrder: number; note: string };
    expect(row.entryId).toBe(entryId);
    expect(row.poiId).toBeGreaterThan(0);
    expect(row.sortOrder).toBeGreaterThanOrEqual(1);
    expect(row.note).toBe('happy hour');

    // POI master 入庫（source=ai）且 trip_entry_pois 關聯指向它
    const poi = await db.prepare('SELECT name, type, source FROM pois WHERE id = ?').bind(row.poiId).first<Record<string, unknown>>();
    expect(poi).toEqual({ name: 's10-pr39 entry POI', type: 'restaurant', source: 'ai' });
    const link = await db.prepare('SELECT entry_id, poi_id, note FROM trip_entry_pois WHERE id = ?').bind(row.id).first<Record<string, unknown>>();
    expect(link).toEqual({ entry_id: entryId, poi_id: row.poiId, note: 'happy hour' });

    // entry_pois_version 加 1
    const after = await db.prepare('SELECT entry_pois_version FROM trip_entries WHERE id = ?').bind(entryId).first<{ entry_pois_version: number }>();
    expect(after!.entry_pois_version).toBe((before?.entry_pois_version ?? 0) + 1);

    // audit_log 寫入（PR32 already integrated）
    const audit = await db
      .prepare(`SELECT changed_by, table_name FROM audit_log WHERE trip_id = ? AND table_name = 'trip_entry_pois' ORDER BY id DESC LIMIT 1`)
      .bind(tripId)
      .first<{ changed_by: string; table_name: string }>();
    expect(audit?.changed_by).toBe(ownerEmail);
  });

  it('重複 POI 同 entry → 409 DATA_CONFLICT，且不重複關聯、version 不再加', async () => {
    // 先建立第一個
    const first = await callAddPoi({ name: 's10-pr39 duplicate', type: 'restaurant' });
    expect(first.status).toBe(201);
    const versionAfterFirst = (await db.prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?').bind(entryId).first<{ v: number }>())!.v;

    // 同 name+type 第二次
    const dup = await callAddPoi({ name: 's10-pr39 duplicate', type: 'restaurant' });
    expect(dup.status).toBe(409);
    const body = await dup.json() as { error: { code: string } };
    expect(body.error.code).toBe('DATA_CONFLICT');

    const links = await db.prepare(
      'SELECT COUNT(*) AS c FROM trip_entry_pois tp JOIN pois p ON p.id = tp.poi_id WHERE tp.entry_id = ? AND p.name = ?',
    ).bind(entryId, 's10-pr39 duplicate').first<{ c: number }>();
    expect(links!.c).toBe(1);
    const versionAfterDup = (await db.prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?').bind(entryId).first<{ v: number }>())!.v;
    expect(versionAfterDup).toBe(versionAfterFirst);
  });

  it('新增的 POI 排在既有的後面（sort_order = max + 1）', async () => {
    const maxBefore = (await db.prepare('SELECT MAX(sort_order) AS m FROM trip_entry_pois WHERE entry_id = ?').bind(entryId).first<{ m: number }>())!.m;
    const res = await callAddPoi({ name: 's10-pr39 order POI', type: 'attraction' });
    expect(res.status).toBe(201);
    const row = await res.json() as { sortOrder: number };
    expect(row.sortOrder).toBe(maxBefore + 1);
  });
});
