/**
 * Integration test — PATCH / DELETE /api/pois/:id
 *
 * 走 HTTP 邊界（tests/api/http.ts）：使用者用真實 bearer token，維運用 ops:poi 的 service token，
 * 斷言都落在 Response 與真實 D1 的資料變化。
 * 共用 D1：專屬 trip／email，POI 名稱一律 `s10-pois-` 前綴（pois 的 name+type 唯一約束跨檔會衝突），結束時清掉。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';
import { cleanupTrips } from './cleanup-trips';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
let poiId: number;
const poiIds: number[] = [];

const tripOwner = 's10-pois-companion@example.test';
const stranger = 's10-pois-stranger@example.test';
const permTrip = 's10-pois-perm-trip';

const newPoi = async (opts: { type?: string; name: string }) => {
  const id = await seedPoi(db, { type: opts.type, name: `s10-pois-${opts.name}` });
  poiIds.push(id);
  return id;
};

const opsToken = () => serviceToken(db, ['ops:poi'], 'poi-cli');
const patchAsOps = async (id: number | string, json: unknown) =>
  api.request('PATCH', `/api/pois/${id}`, { bearer: await opsToken(), json });
const deleteAsOps = async (id: number | string) =>
  api.request('DELETE', `/api/pois/${id}`, { bearer: await opsToken() });
const poiRow = (id: number) => db.prepare('SELECT * FROM pois WHERE id = ?').bind(id).first<Record<string, unknown>>();

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
  poiId = await newPoi({ type: 'hotel', name: 'Test Hotel' });
});

afterAll(async () => {
  const marks = poiIds.map(() => '?').join(',');
  await db.prepare(`DELETE FROM audit_log WHERE table_name = 'pois' AND record_id IN (${marks})`).bind(...poiIds).run();
  await db.prepare('UPDATE trip_days SET hotel_poi_id = NULL WHERE trip_id LIKE ?').bind('s10-pois-%').run();
  await cleanupTrips(db, ['s10-pois-%'], ['s10-pois-%']);
  await db.prepare('DELETE FROM users WHERE email LIKE ?').bind('s10-pois-%').run();
  await disposeMiniflare();
});

describe('PATCH /api/pois/:id', () => {
  it('admin 更新 POI → 200', async () => {
    // Migration 0045: rename google_rating → rating (1-7 OpenTripMap scale).
    const resp = await patchAsOps(poiId, { rating: 4.5, address: '沖繩縣那霸市' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { id: number; rating: number };
    expect(body.id).toBe(poiId);
    expect(body.rating).toBe(4.5);
    const poi = await poiRow(poiId);
    expect(poi!.rating).toBe(4.5);
    expect(poi!.address).toBe('沖繩縣那霸市');
  });

  it('更新後寫入 audit_log（誰、哪個 POI、改了什麼）', async () => {
    const id = await newPoi({ name: 'Audit POI' });
    const resp = await patchAsOps(id, { address: '審計地址' });
    expect(resp.status).toBe(200);
    const audit = await db
      .prepare("SELECT changed_by, trip_id, action, diff_json FROM audit_log WHERE table_name = 'pois' AND record_id = ?")
      .bind(id)
      .first<{ changed_by: string; trip_id: string; action: string; diff_json: string }>();
    expect(audit?.changed_by).toBe('service:poi-cli');
    expect(audit?.trip_id).toBe('global');
    expect(audit?.action).toBe('update');
    expect(audit?.diff_json).toContain('審計地址');
  });

  it('非 admin 不帶 tripId → 400', async () => {
    const resp = await api.request('PATCH', `/api/pois/${poiId}`, { as: 's10-pois-user@example.test', json: { name: 'x' } });
    expect(resp.status).toBe(400);
    expect((await poiRow(poiId))!.name).toBe('s10-pois-Test Hotel');
  });

  it('不存在 → 404', async () => {
    expect((await patchAsOps(99999, { name: 'x' })).status).toBe(404);
  });

  it('id 格式錯誤 → 400', async () => {
    expect((await patchAsOps('abc', { name: 'x' })).status).toBe(400);
  });

  it('沒有任何允許的欄位 → 400，且不能改 type／id 這類不在白名單的欄位', async () => {
    const id = await newPoi({ type: 'restaurant', name: 'Whitelist POI' });
    const resp = await patchAsOps(id, { type: 'hotel', id: 1 });
    expect(resp.status).toBe(400);
    const row = await poiRow(id);
    expect(row!.type).toBe('restaurant');
    expect(row!.id).toBe(id);
  });

  it('未認證 → 401', async () => {
    const resp = await api.request('PATCH', `/api/pois/${poiId}`, {
      json: { name: 'x' },
      headers: { Origin: 'https://trip-planner-dby.pages.dev' },
    });
    expect(resp.status).toBe(401);
  });

  it('沒有 ops:poi scope 的 service token 不帶 tripId → 400（不因為是 service token 就放行）', async () => {
    const token = await serviceToken(db, ['companion'], 'not-ops');
    const resp = await api.request('PATCH', `/api/pois/${poiId}`, { bearer: token, json: { address: '不該寫入' } });
    expect(resp.status).toBe(400);
    expect((await poiRow(poiId))!.address).not.toBe('不該寫入');
  });
});

describe('PATCH /api/pois/:id — tripId 權限', () => {
  beforeAll(async () => {
    await seedTrip(db, { id: permTrip, owner: tripOwner });
    const dayId = await getDayId(db, permTrip, 1);
    const entryId = await seedEntry(db, dayId);
    await db
      .prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)')
      .bind(entryId, poiId)
      .run();
  });

  it('帶 tripId + 有權限 + POI 屬於該 trip → 200', async () => {
    const resp = await api.request('PATCH', `/api/pois/${poiId}`, {
      as: tripOwner,
      json: { tripId: permTrip, lat: 26.3344, lng: 127.7731 },
    });
    expect(resp.status).toBe(200);
    const poi = await poiRow(poiId);
    expect(poi!.lat).toBe(26.3344);
    expect(poi!.lng).toBe(127.7731);
    // tripId 不是 POI 欄位，不會被寫進去；audit 以該 trip 為歸屬
    expect(poi).not.toHaveProperty('trip_id');
    const audit = await db
      .prepare("SELECT trip_id, changed_by FROM audit_log WHERE table_name = 'pois' AND record_id = ? ORDER BY id DESC LIMIT 1")
      .bind(poiId)
      .first<{ trip_id: string; changed_by: string }>();
    expect(audit?.trip_id).toBe(permTrip);
    expect(audit?.changed_by).toBe(tripOwner);
  });

  it('帶 tripId + 無權限 → 403，資料不變', async () => {
    const before = await poiRow(poiId);
    const resp = await api.request('PATCH', `/api/pois/${poiId}`, {
      as: stranger,
      json: { tripId: permTrip, lat: 0 },
    });
    expect(resp.status).toBe(403);
    expect((await poiRow(poiId))!.lat).toBe(before!.lat);
  });

  it('帶 tripId + POI 不屬於該 trip → 403', async () => {
    const otherPoiId = await newPoi({ type: 'restaurant', name: 'Unlinked POI' });
    const resp = await api.request('PATCH', `/api/pois/${otherPoiId}`, {
      as: tripOwner,
      json: { tripId: permTrip, lat: 0 },
    });
    expect(resp.status).toBe(403);
    expect((await poiRow(otherPoiId))!.lat).toBeNull();
  });

  // v2.29.0: 「舊 trip_pois timeline row 不授權」test removed — trip_pois table DROPPED。

  it('不帶 tripId + 非 admin → 400', async () => {
    const resp = await api.request('PATCH', `/api/pois/${poiId}`, { as: tripOwner, json: { lat: 0 } });
    expect(resp.status).toBe(400);
  });

  it('不帶 tripId + admin → 200（向下相容）', async () => {
    const resp = await patchAsOps(poiId, { address: '那霸市前島 2-3-1' });
    expect(resp.status).toBe(200);
    expect((await poiRow(poiId))!.address).toBe('那霸市前島 2-3-1');
  });
});

describe('PATCH /api/pois/:id — price (migration 0054)', () => {
  it('admin 更新 pois.price → 200 + DB 寫入', async () => {
    const restPoiId = await newPoi({ type: 'restaurant', name: 'Price Test 拉麵' });
    const resp = await patchAsOps(restPoiId, { price: '¥800~1200' });
    expect(resp.status).toBe(200);
    expect((await poiRow(restPoiId))!.price).toBe('¥800~1200');
  });
});

// Round 4 fix adv-C1 / Codex F1 regression: migration 0057 adds trip_entry_pois with
// ON DELETE RESTRICT FK. Pre-fix, DELETE pois would 500 for any POI used as master/alt
// because trip_entry_pois junction rows blocked it. The fix prepends a DELETE FROM
// trip_entry_pois inside the admin POI delete handler.
describe('DELETE /api/pois/:id — v2.27.0 trip_entry_pois cleanup', () => {
  it('admin DELETE POI referenced as master in trip_entry_pois → succeeds + clears junction', async () => {
    const TRIP = 's10-pois-del';
    await seedTrip(db, { id: TRIP });
    const dayId = await getDayId(db, TRIP, 1);
    const targetPoi = await newPoi({ name: 'AdmDel-Master', type: 'attraction' });
    // v2.29.0: seedEntry({poiId}) 已自動 INSERT trip_entry_pois sort_order=1。
    await seedEntry(db, dayId, { poiId: targetPoi });

    // Pre-condition: junction row exists
    const before = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE poi_id = ?')
      .bind(targetPoi)
      .first<{ c: number }>();
    expect(before!.c).toBe(1);

    const resp = await deleteAsOps(targetPoi);
    expect(resp.status).toBe(200);
    // json() helper applies deepCamel — snake_case keys become camelCase in response
    const body = await resp.json() as { ok: boolean; deletedTripEntryPois: number };
    expect(body.ok).toBe(true);
    expect(body.deletedTripEntryPois).toBe(1);

    // Post-condition: POI gone + junction row gone
    expect(await poiRow(targetPoi)).toBeNull();
    const junctionAfter = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE poi_id = ?')
      .bind(targetPoi)
      .first<{ c: number }>();
    expect(junctionAfter!.c).toBe(0);

    // 刪除有留 audit_log 快照
    const audit = await db
      .prepare("SELECT action, changed_by, snapshot FROM audit_log WHERE table_name = 'pois' AND record_id = ? AND action = 'delete'")
      .bind(targetPoi)
      .first<{ action: string; changed_by: string; snapshot: string }>();
    expect(audit?.changed_by).toBe('service:poi-cli');
    expect(audit?.snapshot).toContain('AdmDel-Master');
  });

  it('admin DELETE POI referenced as alternate in trip_entry_pois → succeeds', async () => {
    const TRIP = 's10-pois-del-alt';
    await seedTrip(db, { id: TRIP });
    const dayId = await getDayId(db, TRIP, 1);
    const masterPoi = await newPoi({ name: 'AdmDel-Alt-M', type: 'attraction' });
    const altPoi = await newPoi({ name: 'AdmDel-Alt-A', type: 'attraction' });
    // v2.29.0: seedEntry({poiId}) 已自動 INSERT master sort_order=1，只補 alternate。
    const entryId = await seedEntry(db, dayId, { poiId: masterPoi });
    await db
      .prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)')
      .bind(entryId, altPoi)
      .run();

    const resp = await deleteAsOps(altPoi);
    expect(resp.status).toBe(200);
    // Master row should survive
    const masterRow = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number }>();
    expect(masterRow!.poi_id).toBe(masterPoi);
  });

  it('DELETE 被當作某天的住宿 POI → 該天 hotel_poi_id 清成 NULL', async () => {
    const TRIP = 's10-pois-del-hotel';
    await seedTrip(db, { id: TRIP });
    const dayId = await getDayId(db, TRIP, 1);
    const hotel = await newPoi({ name: 'AdmDel-Hotel', type: 'hotel' });
    await db.prepare('UPDATE trip_days SET hotel_poi_id = ? WHERE id = ?').bind(hotel, dayId).run();

    expect((await deleteAsOps(hotel)).status).toBe(200);
    const day = await db.prepare('SELECT hotel_poi_id FROM trip_days WHERE id = ?').bind(dayId).first<{ hotel_poi_id: number | null }>();
    expect(day!.hotel_poi_id).toBeNull();
  });

  it('一般使用者（即使是 trip owner）不可 DELETE master POI → 403，POI 仍在', async () => {
    const target = await newPoi({ name: 'NoDel-ByOwner', type: 'attraction' });
    const resp = await api.request('DELETE', `/api/pois/${target}`, { as: tripOwner });
    expect(resp.status).toBe(403);
    expect(await poiRow(target)).not.toBeNull();
  });

  it('DELETE 不存在 → 404', async () => {
    expect((await deleteAsOps(99998)).status).toBe(404);
  });
});
