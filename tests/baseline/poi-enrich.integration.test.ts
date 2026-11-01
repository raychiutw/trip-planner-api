/**
 * Integration test — POST /api/pois/:id/enrich
 *
 * v2.33.106 T-1: 涵蓋 auth gate / validation / place_id 缺失 / Google API
 * failure / business_status 三條 branch (OPERATIONAL / CLOSED_PERMANENTLY /
 * 404 missing) + non-admin tripId gate。
 *
 * 走 HTTP 邊界（tests/api/http.ts）：使用者用真實 bearer token，維運用 ops:poi 的 service token。
 * Google Place Details 是外部邊界：用 tests/api/google-stub.ts 攔截 global fetch 回 fixture，
 * 並明確斷言送出的 method、URL、金鑰 header、field mask。
 * 共用 D1：專屬 trip／email／POI 名稱前綴 `s10-enrich`（pois 的 name+type 唯一約束跨檔會衝突），結束時清掉。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, seedTrip, seedUser, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { stubGoogle, jsonOk } from './google-stub';
import { serviceToken } from './service-token';
import { cleanupTrips } from './cleanup-trips';
import { invalidateLockCache } from '../../src/lib/maps-lock';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const google = stubGoogle();
const API_KEY = 'test-key';
const TRIP = 's10-enrich-trip';
const owner = 's10-enrich-owner@example.test';
const viewer = 's10-enrich-viewer@example.test';
const stranger = 's10-enrich-stranger@example.test';
const poiIds: number[] = [];

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: API_KEY, ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
  await seedTrip(db, { id: TRIP, owner });
  await seedUser(db, viewer);
  await db.prepare('INSERT INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, ?)')
    .bind(userIdFor(viewer), TRIP, 'viewer').run();
});

afterAll(async () => {
  google.restore();
  if (poiIds.length) {
    const marks = poiIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM audit_log WHERE table_name = 'pois' AND record_id IN (${marks})`).bind(...poiIds).run();
  }
  await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP], ['s10-enrich-%']);
  await db.prepare('DELETE FROM users WHERE email LIKE ?').bind('s10-enrich-%').run();
  await disposeMiniflare();
});

beforeEach(() => {
  google.reset();
});

/** 建 POI 並（預設）掛進 TRIP 的第一天，讓 trip 成員的 tripId 授權成立。 */
async function seedPoiWithPlaceId(name: string, placeId: string | null, opts: { link?: boolean } = {}): Promise<number> {
  const id = await seedPoi(db, { name: `s10-enrich-${name}` });
  poiIds.push(id);
  await db.prepare('UPDATE pois SET place_id = ? WHERE id = ?').bind(placeId, id).run();
  if (opts.link !== false) {
    const day = await db.prepare('SELECT id FROM trip_days WHERE trip_id = ? ORDER BY day_num LIMIT 1')
      .bind(TRIP).first<{ id: number }>();
    const entry = await db.prepare(
      'INSERT INTO trip_entries (day_id, sort_order) VALUES (?, ?) RETURNING id',
    ).bind(day!.id, 1000 + id).first<{ id: number }>();
    await db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, id).run();
  }
  return id;
}

const poiRow = (id: number) => db.prepare('SELECT * FROM pois WHERE id = ?').bind(id).first<Record<string, unknown>>();

const placeDetails = (over: Record<string, unknown> = {}) => ({
  id: 'ChIJ_any',
  displayName: { text: 'Any' },
  formattedAddress: 'Taipei',
  location: { latitude: 25.0, longitude: 121.5 },
  rating: 4.5,
  businessStatus: 'OPERATIONAL',
  regularOpeningHours: { weekdayDescriptions: ['星期一: 09:00-18:00', '星期二: 09:00-18:00'] },
  ...over,
});

const enrich = async (poiId: number | string, opts: { tripId?: boolean; as?: string; ops?: boolean; client?: Api } = {}) => {
  const client = opts.client ?? api;
  const path = `/api/pois/${poiId}/enrich${opts.tripId ? `?tripId=${TRIP}` : ''}`;
  if (opts.ops) return client.request('POST', path, { bearer: await serviceToken(db, ['ops:poi'], 'poi-cli') });
  return client.request('POST', path, { as: opts.as ?? owner });
};

describe('POST /api/pois/:id/enrich (T-1)', () => {
  it('未認證 → 401', async () => {
    const poiId = await seedPoiWithPlaceId('A', 'ChIJ_A');
    const res = await api.request('POST', `/api/pois/${poiId}/enrich?tripId=${TRIP}`, {
      headers: { Origin: 'https://trip-planner-dby.pages.dev' },
    });
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it('id 非正整數 → 400', async () => {
    const res = await enrich('abc', { tripId: true });
    expect(res.status).toBe(400);
  });

  it('non-admin 缺 tripId → 400', async () => {
    const poiId = await seedPoiWithPlaceId('B', 'ChIJ_B');
    const res = await enrich(poiId, { as: owner });
    expect(res.status).toBe(400);
    expect(google.calls).toHaveLength(0);
  });

  it('non-admin 無寫權限該 trip → 403', async () => {
    const poiId = await seedPoiWithPlaceId('C', 'ChIJ_C');
    const res = await enrich(poiId, { tripId: true, as: stranger });
    expect(res.status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });

  it('viewer 對該 trip 只有讀權限 → 403', async () => {
    const poiId = await seedPoiWithPlaceId('Viewer', 'ChIJ_Viewer');
    const res = await enrich(poiId, { tripId: true, as: viewer });
    expect(res.status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });

  it('owner 帶 tripId 但 POI 不屬於該 trip → 403', async () => {
    const poiId = await seedPoiWithPlaceId('Unlinked', 'ChIJ_Unlinked', { link: false });
    const res = await enrich(poiId, { tripId: true });
    expect(res.status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });

  it('POI 不存在 → 404', async () => {
    const res = await enrich(999999, { ops: true });
    expect(res.status).toBe(404);
    expect(google.calls).toHaveLength(0);
  });

  it('POI 缺 place_id → 400', async () => {
    const poiId = await seedPoiWithPlaceId('NoPlace', null);
    const res = await enrich(poiId, { ops: true });
    expect(res.status).toBe(400);
    expect(google.calls).toHaveLength(0);
  });

  it('GOOGLE_MAPS_API_KEY 缺 → 502', async () => {
    const poiId = await seedPoiWithPlaceId('D', 'ChIJ_D');
    const noKey = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: '' }) });
    const res = await enrich(poiId, { ops: true, client: noKey });
    expect(res.status).toBe(502);
    expect(google.calls).toHaveLength(0);
  });

  it('kill switch 啟用 → 503 MAPS_LOCKED，且不打 Google', async () => {
    const poiId = await seedPoiWithPlaceId('Locked', 'ChIJ_Locked');
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
    invalidateLockCache();
    try {
      const res = await enrich(poiId, { ops: true });
      expect(res.status).toBe(503);
      expect(google.calls).toHaveLength(0);
    } finally {
      await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
      invalidateLockCache();
    }
  });

  it('happy path OPERATIONAL → status=active + rating 寫入，並送出正確的 Place Details 請求', async () => {
    google.respond(() => jsonOk(placeDetails({ id: 'ChIJ_Happy' })));
    const poiId = await seedPoiWithPlaceId('Happy', 'ChIJ_Happy');
    const resp = await enrich(poiId, { ops: true });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('active');
    expect(data.rating).toBe(4.5);

    // 確認 D1 row 寫入
    const row = await poiRow(poiId);
    expect(row?.rating).toBe(4.5);
    expect(row?.status).toBe('active');
    expect(row?.address).toBe('Taipei');
    expect(row?.lat).toBe(25.0);
    expect(row?.lng).toBe(121.5);
    expect(row?.hours).toBe('星期一: 09:00-18:00\n星期二: 09:00-18:00');
    expect(row?.status_checked_at).toEqual(expect.any(String));

    // 送給 Google 的請求：GET Place Details，金鑰在 header、field mask 限縮
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://places.googleapis.com/v1/places/ChIJ_Happy?languageCode=zh-TW');
    expect(call.url).not.toContain(API_KEY);
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
    expect(call.headers.get('X-Goog-FieldMask')).toBe(
      'id,displayName,formattedAddress,location,rating,businessStatus,regularOpeningHours.weekdayDescriptions,internationalPhoneNumber,priceLevel',
    );
    expect(JSON.stringify(data)).not.toContain(API_KEY);
  });

  it('CLOSED_PERMANENTLY → status=closed + reason=永久歇業，並寫進 D1', async () => {
    google.respond(() => jsonOk(placeDetails({ businessStatus: 'CLOSED_PERMANENTLY', rating: 3.0, formattedAddress: 'Old Address', regularOpeningHours: undefined })));
    const poiId = await seedPoiWithPlaceId('Closed', 'ChIJ_Closed');
    const resp = await enrich(poiId, { ops: true });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('closed');
    expect(data.statusReason).toBe('永久歇業');
    const row = await poiRow(poiId);
    expect(row?.status).toBe('closed');
    expect(row?.status_reason).toBe('永久歇業');
  });

  it('CLOSED_TEMPORARILY → status=active（暫時不警告）', async () => {
    google.respond(() => jsonOk(placeDetails({ businessStatus: 'CLOSED_TEMPORARILY', rating: 4.0, formattedAddress: 'Tmp Closed' })));
    const poiId = await seedPoiWithPlaceId('TmpClosed', 'ChIJ_TmpClosed');
    const resp = await enrich(poiId, { ops: true });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('active');
    expect(data.statusReason).toBeNull();
  });

  it('Google 404 → status=missing + reason=Google Maps 查無資料', async () => {
    google.respond(() => new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 }));
    const poiId = await seedPoiWithPlaceId('Missing', 'ChIJ_Missing');
    await db.prepare('UPDATE pois SET rating = 4.1 WHERE id = ?').bind(poiId).run();
    const resp = await enrich(poiId, { ops: true });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('missing');
    expect(data.statusReason).toBe('Google Maps 查無資料');
    // 查無資料不應清掉既有的人工／舊資料
    expect((await poiRow(poiId))?.rating).toBe(4.1);
  });

  it('Google 回 503 → 502 MAPS_UPSTREAM_FAILED，POI 資料不變', async () => {
    google.respond(() => jsonOk(placeDetails(), 503));
    const poiId = await seedPoiWithPlaceId('Upstream', 'ChIJ_Upstream');
    const resp = await enrich(poiId, { ops: true });
    expect(resp.status).toBe(502);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('MAPS_UPSTREAM_FAILED');
    expect((await poiRow(poiId))?.status_checked_at).toBeNull();
  });

  it('Google 沒回的欄位不覆蓋既有資料（COALESCE），有回的才更新', async () => {
    google.respond(() => jsonOk(placeDetails({ formattedAddress: undefined, rating: 4.8 })));
    const poiId = await seedPoiWithPlaceId('Coalesce', 'ChIJ_Coalesce');
    await db.prepare("UPDATE pois SET address = '手動填的地址', phone = '+81-90-0000-0000' WHERE id = ?").bind(poiId).run();
    const resp = await enrich(poiId, { ops: true });
    expect(resp.status).toBe(200);
    const row = await poiRow(poiId);
    expect(row?.address).toBe('手動填的地址');
    expect(row?.phone).toBe('+81-90-0000-0000');
    expect(row?.rating).toBe(4.8);
  });

  it('owner with trip write permission → 200，並寫入 audit_log', async () => {
    google.respond(() => jsonOk(placeDetails({ rating: 4.2, formattedAddress: 'Owner Test' })));
    const poiId = await seedPoiWithPlaceId('OwnerPath', 'ChIJ_OwnerPath');
    const resp = await enrich(poiId, { tripId: true });
    expect(resp.status).toBe(200);
    const audit = await db
      .prepare("SELECT changed_by, trip_id, diff_json FROM audit_log WHERE table_name = 'pois' AND record_id = ?")
      .bind(poiId)
      .first<{ changed_by: string; trip_id: string; diff_json: string }>();
    expect(audit?.changed_by).toBe(owner);
    expect(audit?.trip_id).toBe(TRIP);
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ op: 'enrich', placeId: 'ChIJ_OwnerPath', status: 'active' });
  });
});
