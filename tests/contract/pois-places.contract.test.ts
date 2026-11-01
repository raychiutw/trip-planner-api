/**
 * pois-places 組的契約測試：實際回應必須符合 OpenAPI 文件的 schema（多出未宣告的欄位也算失敗）。
 * 走 HTTP 邊界（createApi）；Google 一律用 google-stub 攔截，不連線。
 * 共用 D1 為每檔獨立的記憶體資料庫；email／trip／POI 名稱用 `pp-` 前綴。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedPoi, seedTrip, seedUser, userIdFor } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { stubGoogle, jsonOk } from '../baseline/google-stub';
import { serviceToken } from '../baseline/service-token';
import { invalidateLockCache } from '../../src/lib/maps-lock';
import { ApiError } from '../../src/schemas/common';
import { contractIssues, expectContract } from './support';
import * as S from '../../src/schemas/pois-places';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const google = stubGoogle();
const KEY = 'test-key';
const TRIP = 'pp-trip';
const owner = 'pp-owner@example.test';
const stranger = 'pp-stranger@example.test';
const other = 'pp-other@example.test';

/** 文件裡出現過的狀態碼都必須有測試實際觸發：這裡記錄「方法 路徑 → 狀態碼」。 */
const hits = new Set<string>();
const hit = (route: string, res: Response): Response => { hits.add(`${route} ${res.status}`); return res; };

const ROUTES: Array<{ method: string; path: string; auth: 'required' | 'none'; body: boolean }> = [
  { method: 'post', path: '/api/places/autocomplete', auth: 'required', body: true },
  { method: 'get', path: '/api/places/resolve', auth: 'required', body: false },
  { method: 'get', path: '/api/poi-favorites', auth: 'required', body: false },
  { method: 'post', path: '/api/poi-favorites', auth: 'required', body: true },
  { method: 'delete', path: '/api/poi-favorites/{id}', auth: 'required', body: false },
  { method: 'post', path: '/api/poi-favorites/{id}/add-to-trip', auth: 'required', body: true },
  { method: 'get', path: '/api/poi-search', auth: 'none', body: false },
  { method: 'patch', path: '/api/pois/{id}', auth: 'required', body: true },
  { method: 'delete', path: '/api/pois/{id}', auth: 'required', body: false },
  { method: 'post', path: '/api/pois/{id}/enrich', auth: 'required', body: false },
  { method: 'post', path: '/api/pois/find-or-create', auth: 'required', body: true },
  { method: 'get', path: '/api/route', auth: 'none', body: false },
  { method: 'get', path: '/api/public-config', auth: 'none', body: false },
];
const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: KEY, GOOGLE_CLIENT_ID: 'gid', ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
  await seedTrip(db, { id: TRIP, owner });
  await seedUser(db, stranger);
  await seedUser(db, other);
});
afterAll(async () => { google.restore(); await disposeMiniflare(); });
beforeEach(() => { google.reset(); invalidateLockCache(); });

const lockBucket = (bucketKey: string) =>
  db.prepare(
    `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, 99999, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET count = 99999, window_start = excluded.window_start, locked_until = excluded.locked_until`,
  ).bind(bucketKey, Date.now(), Date.now() + 3600_000).run();
const lockMaps = async () => {
  await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
  invalidateLockCache();
};
const unlockMaps = async () => {
  await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
  invalidateLockCache();
};
const noKeyApi = () => createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: '' }) });
const apiErr = async (res: Response, code: string) => {
  const body = await res.json();
  expectContract(ApiError, body);
  expect((body as { error: { code: string } }).error.code).toBe(code);
};

const placeDetails = (over: Record<string, unknown> = {}) => ({
  id: 'ChIJ_pp', displayName: { text: 'PP Place' }, formattedAddress: 'Taipei',
  location: { latitude: 25.0, longitude: 121.5 }, rating: 4.5, businessStatus: 'OPERATIONAL', priceLevel: 'PRICE_LEVEL_MODERATE',
  regularOpeningHours: { weekdayDescriptions: ['星期一: 09:00-18:00', '星期二: 09:00-18:00'] }, ...over,
});

/** 建 POI 並掛到 TRIP 第一天，讓 trip 成員的 tripId 授權成立。 */
async function seedTripPoi(name: string, placeId: string | null = null): Promise<number> {
  const id = await seedPoi(db, { name: `pp-${name}` });
  await db.prepare('UPDATE pois SET place_id = ? WHERE id = ?').bind(placeId, id).run();
  const day = await db.prepare('SELECT id FROM trip_days WHERE trip_id = ? ORDER BY day_num LIMIT 1').bind(TRIP).first<{ id: number }>();
  const entry = await db.prepare('INSERT INTO trip_entries (day_id, sort_order) VALUES (?, ?) RETURNING id').bind(day!.id, 5000 + id).first<{ id: number }>();
  await db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, id).run();
  return id;
}
async function seedFavorite(email: string, name: string, note: string | null = null): Promise<{ favId: number; poiId: number }> {
  const userId = await seedUser(db, email);
  const poiId = await seedPoi(db, { name: `pp-fav-${name}` });
  const row = await db.prepare('INSERT INTO poi_favorites (user_id, poi_id, note) VALUES (?, ?, ?) RETURNING id').bind(userId, poiId, note).first<{ id: number }>();
  return { favId: row!.id, poiId };
}


const AC = '/api/places/autocomplete', RES = '/api/places/resolve', FAVS = '/api/poi-favorites', FAV = '/api/poi-favorites/{id}',
  ATT = '/api/poi-favorites/{id}/add-to-trip', SEARCH = '/api/poi-search', POI = '/api/pois/{id}', ENR = '/api/pois/{id}/enrich',
  FOC = '/api/pois/find-or-create', ROUTE = '/api/route', CFG = '/api/public-config';

describe('places', () => {
  const post = (route: string, body: unknown, as = owner, client: Api = api) =>
    client.request('POST', AC, { as, json: body }).then((r) => hit(route, r));
  it('autocomplete 200', async () => {
    google.respond(() => jsonOk({ suggestions: [{ placePrediction: { placeId: 'ChIJ_a', structuredFormat: { mainText: { text: '高雄' }, secondaryText: { text: 'Taiwan' } } } }] }));
    const res = await post(key('post', AC), { q: '高雄市', sessionToken: 's1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Pois_AutocompleteResponse, body);
    expect((body as { predictions: unknown[] }).predictions).toHaveLength(1);
  });
  it('autocomplete 400／401／429／502／503', async () => {
    await apiErr(await post(key('post', AC), { q: 'x', sessionToken: 's1' }), 'DATA_VALIDATION');
    const anon = hit(key('post', AC), await api.request('POST', AC, { json: { q: '高雄市', sessionToken: 's' } }));
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    google.respond(() => jsonOk({ suggestions: [] }));
    await lockBucket(`places-autocomplete:user-${userIdFor(stranger)}`);
    const limited = await post(key('post', AC), { q: '高雄市', sessionToken: 's' }, stranger);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expectContract(S.Pois_RateLimitedNoMessage, await limited.json());
    const noKey = await post(key('post', AC), { q: '高雄市', sessionToken: 's' }, owner, noKeyApi());
    expect(noKey.status).toBe(502); await apiErr(noKey, 'MAPS_UPSTREAM_FAILED');
    await lockMaps();
    try { const locked = await post(key('post', AC), { q: '高雄市', sessionToken: 's' }); expect(locked.status).toBe(503); await apiErr(locked, 'MAPS_LOCKED'); } finally { await unlockMaps(); }
  });

  const get = (qs: string, as = owner, client: Api = api) => client.request('GET', `${RES}${qs}`, { as }).then((r) => hit(key('get', RES), r));
  it('resolve 200（含 hours／priceLevel 為 null 的情況）', async () => {
    google.respond(() => jsonOk(placeDetails()));
    const res = await get('?placeId=ChIJ_pp&sessionToken=s');
    expect(res.status).toBe(200);
    expectContract(S.Pois_ResolveResponse, await res.json());
    google.respond(() => jsonOk(placeDetails({ regularOpeningHours: undefined, priceLevel: undefined })));
    const bare = await get('?placeId=ChIJ_pp2');
    const body = await bare.json() as { hours: unknown; priceLevel: unknown };
    expectContract(S.Pois_ResolveResponse, body);
    expect(body.hours).toBeNull(); expect(body.priceLevel).toBeNull();
  });
  it('resolve 400／401／404／429／502／503', async () => {
    await apiErr(await get(''), 'DATA_VALIDATION');
    const anon = hit(key('get', RES), await api.get(`${RES}?placeId=x`));
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    google.respond(() => new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 }));
    const nf = await get('?placeId=ChIJ_gone'); expect(nf.status).toBe(404); await apiErr(nf, 'DATA_NOT_FOUND');
    await lockBucket(`places-resolve:user-${userIdFor(stranger)}`);
    const limited = await get('?placeId=ChIJ_a', stranger);
    expect(limited.status).toBe(429); expectContract(S.Pois_RateLimitedNoMessage, await limited.json());
    const noKey = await get('?placeId=ChIJ_a', owner, noKeyApi()); expect(noKey.status).toBe(502); await apiErr(noKey, 'MAPS_UPSTREAM_FAILED');
    await lockMaps();
    try { const locked = await get('?placeId=ChIJ_a'); expect(locked.status).toBe(503); await apiErr(locked, 'MAPS_LOCKED'); } finally { await unlockMaps(); }
  });
});

describe('poi-favorites', () => {
  const IP = '198.51.100.71';
  const req = (method: string, route: string, path: string, opts: Parameters<Api['request']>[2]) =>
    api.request(method, path, { ...opts, headers: { 'CF-Connecting-IP': IP, ...(opts?.headers ?? {}) } }).then((r) => hit(key(method, route), r));
  beforeEach(() => db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${IP}`).run());

  it('GET 列表 200（含收藏的 usages，飯店用途 entryId 為 null）', async () => {
    const { poiId } = await seedFavorite(owner, 'list', '備註');
    const day = await db.prepare('SELECT id FROM trip_days WHERE trip_id = ? AND day_num = 1').bind(TRIP).first<{ id: number }>();
    const entry = await db.prepare('INSERT INTO trip_entries (day_id, sort_order) VALUES (?, 7001) RETURNING id').bind(day!.id).first<{ id: number }>();
    await db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, poiId).run();
    await db.prepare('UPDATE trip_days SET hotel_poi_id = ? WHERE trip_id = ? AND day_num = 2').bind(poiId, TRIP).run();
    const res = await req('GET', FAVS, FAVS, { as: owner });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ usages: Array<{ entryId: number | null }> }>;
    expectContract(S.Pois_FavoriteListResponse, body);
    const withUsage = body.find((b) => b.usages.length === 2)!;
    expect(withUsage.usages.map((u) => u.entryId).sort()).toEqual([entry!.id, null].sort());
  });
  it('GET 匿名 → 401（requireAuth）；受限 token → 403', async () => {
    const anon = await req('GET', FAVS, FAVS, {});
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const restricted = await req('GET', FAVS, FAVS, { as: owner, restrictTrip: TRIP });
    expect(restricted.status).toBe(403); await apiErr(restricted, 'PERM_DENIED');
  });

  it('POST 201（新建與重新啟用 soft-deleted 都是同一個形狀）', async () => {
    const userId = await seedUser(db, other);
    const poiId = await seedPoi(db, { name: 'pp-post-poi' });
    const res = await req('POST', FAVS, FAVS, { as: other, json: { poiId, note: 'n' } });
    expect(res.status).toBe(201);
    const row = await res.json() as { id: number; deletedAt: unknown };
    expectContract(S.Pois_FavoriteRow, row);
    expect(row.deletedAt).toBeNull();
    await db.prepare("UPDATE poi_favorites SET deleted_at = datetime('now') WHERE id = ?").bind(row.id).run();
    const again = await req('POST', FAVS, FAVS, { as: other, json: { poiId } });
    expect(again.status).toBe(201);
    expectContract(S.Pois_FavoriteRow, await again.json());
    expect(userId).toBeTruthy();
  });
  it('POST 400／401／403／404／409／429', async () => {
    await apiErr(await req('POST', FAVS, FAVS, { as: owner, json: { poiId: 'x' } }), 'DATA_VALIDATION');
    const anon = await req('POST', FAVS, FAVS, { json: { poiId: 1 } });
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const restricted = await req('POST', FAVS, FAVS, { as: owner, restrictTrip: TRIP, json: { poiId: 1 } });
    expect(restricted.status).toBe(403); await apiErr(restricted, 'PERM_DENIED');
    const missing = await req('POST', FAVS, FAVS, { as: owner, json: { poiId: 987654 } });
    expect(missing.status).toBe(404); await apiErr(missing, 'DATA_NOT_FOUND');
    const poiId = await seedPoi(db, { name: 'pp-dup-poi' });
    await req('POST', FAVS, FAVS, { as: stranger, json: { poiId } });
    const dup = await req('POST', FAVS, FAVS, { as: stranger, json: { poiId } });
    expect(dup.status).toBe(409); await apiErr(dup, 'DATA_CONFLICT');
    await lockBucket(`poi-favorites-pre-gate-ip:${IP}`);
    const limited = await req('POST', FAVS, FAVS, { as: owner, json: { poiId } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expectContract(S.Pois_RateLimitedFlat, await limited.json());
  });

  it('DELETE 204（含已取消的冪等）', async () => {
    const { favId } = await seedFavorite(owner, 'del');
    const res = await req('DELETE', FAV, `${FAVS}/${favId}`, { as: owner });
    expect(res.status).toBe(204); expect(await res.text()).toBe('');
    expect((await req('DELETE', FAV, `${FAVS}/${favId}`, { as: owner })).status).toBe(204);
  });
  it('DELETE 400／401／403／404／429', async () => {
    const { favId } = await seedFavorite(owner, 'del2');
    await apiErr(await req('DELETE', FAV, `${FAVS}/abc`, { as: owner }), 'DATA_VALIDATION');
    const anon = await req('DELETE', FAV, `${FAVS}/${favId}`, {});
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const notMine = await req('DELETE', FAV, `${FAVS}/${favId}`, { as: stranger });
    expect(notMine.status).toBe(403); await apiErr(notMine, 'PERM_DENIED');
    const nf = await req('DELETE', FAV, `${FAVS}/987654`, { as: owner });
    expect(nf.status).toBe(404); await apiErr(nf, 'DATA_NOT_FOUND');
    await lockBucket(`poi-favorites-pre-gate-ip:${IP}`);
    const limited = await req('DELETE', FAV, `${FAVS}/${favId}`, { as: owner });
    expect(limited.status).toBe(429); expectContract(S.Pois_RateLimitedFlat, await limited.json());
  });

  const ATT_BODY = { tripId: TRIP, dayNum: 3, startTime: '10:00', endTime: '11:00' };
  it('add-to-trip 201；時間重疊 → 409 CONFLICT', async () => {
    const { favId } = await seedFavorite(owner, 'att', '收藏備註');
    const res = await req('POST', ATT, `${FAVS}/${favId}/add-to-trip`, { as: owner, json: ATT_BODY });
    expect(res.status).toBe(201);
    expectContract(S.Pois_AddToTripResponse, await res.json());
    const { favId: f2 } = await seedFavorite(owner, 'att2');
    const clash = await req('POST', ATT, `${FAVS}/${f2}/add-to-trip`, { as: owner, json: { ...ATT_BODY, startTime: '10:30', endTime: '12:00' } });
    expect(clash.status).toBe(409);
    const body = await clash.json() as { error: string };
    expectContract(S.Pois_AddToTripConflict, body);
    expect(body.error).toBe('CONFLICT');
  });
  it('add-to-trip 400／401／403／404／429', async () => {
    const { favId } = await seedFavorite(owner, 'att3');
    const url = `${FAVS}/${favId}/add-to-trip`;
    await apiErr(await req('POST', ATT, url, { as: owner, json: { ...ATT_BODY, tripId: undefined } }), 'DATA_VALIDATION');
    const anon = await req('POST', ATT, url, { json: ATT_BODY });
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const { favId: sf } = await seedFavorite(stranger, 'att-stranger');
    const noWrite = await req('POST', ATT, `${FAVS}/${sf}/add-to-trip`, { as: stranger, json: ATT_BODY });
    expect(noWrite.status).toBe(403); await apiErr(noWrite, 'PERM_DENIED');
    const noDay = await req('POST', ATT, url, { as: owner, json: { ...ATT_BODY, dayNum: 99 } });
    expect(noDay.status).toBe(404); await apiErr(noDay, 'DATA_NOT_FOUND');
    await lockBucket(`poi-favorites-pre-gate-ip:${IP}`);
    const limited = await req('POST', ATT, url, { as: owner, json: ATT_BODY });
    expect(limited.status).toBe(429); expectContract(S.Pois_RateLimitedFlat, await limited.json());
  });
});

describe('poi-search（公開）', () => {
  const IP = '198.51.100.81';
  const search = (qs: string, ip = IP, client: Api = api) => client.get(`${SEARCH}?${qs}`, { headers: { 'CF-Connecting-IP': ip } }).then((r) => hit(key('get', SEARCH), r));
  const place = { id: 'ChIJ_pp_s', displayName: { text: 'PP 東京鐵塔' }, formattedAddress: '東京', location: { latitude: 35.6, longitude: 139.7 }, primaryType: 'tourist_attraction', rating: 4.4, businessStatus: 'OPERATIONAL', addressComponents: [{ shortText: 'JP', longText: '日本', types: ['country'] }] };
  it('200：未命中快取（含 nextPageToken）→ 再查一次命中快取', async () => {
    google.respond(() => jsonOk({ places: [place], nextPageToken: 'tok' }));
    const miss = await search('q=pp-東京鐵塔&region=JP');
    expect(miss.status).toBe(200); expect(miss.headers.get('X-Cache')).toBe('MISS');
    const body = await miss.json() as { nextPageToken: unknown; results: unknown[] };
    expectContract(S.Pois_SearchResponse, body);
    expect(body.nextPageToken).toBe('tok'); expect(body.results).toHaveLength(1);
    const cached = await search('q=pp-東京鐵塔&region=JP');
    expect(cached.headers.get('X-Cache')).toBe('HIT');
    const cb = await cached.json() as { nextPageToken: unknown };
    expectContract(S.Pois_SearchResponse, cb); expect(cb.nextPageToken).toBeNull();
  });
  it('400／429／502／503', async () => {
    await apiErr(await search('q=x'), 'DATA_VALIDATION');
    await lockBucket(`poi-search:ip:${IP}2`);
    const limited = await search('q=pp-limited', `${IP}2`);
    expect(limited.status).toBe(429); await apiErr(limited, 'RATE_LIMITED');
    const noKey = await search('q=pp-nokey', `${IP}3`, noKeyApi()); expect(noKey.status).toBe(502); await apiErr(noKey, 'MAPS_UPSTREAM_FAILED');
    await lockMaps();
    try { const locked = await search('q=pp-locked', `${IP}4`); expect(locked.status).toBe(503); await apiErr(locked, 'MAPS_LOCKED'); } finally { await unlockMaps(); }
  });
});

describe('pois', () => {
  const req = (method: string, route: string, path: string, opts: Parameters<Api['request']>[2]) =>
    api.request(method, path, opts).then((r) => hit(key(method, route), r));
  it('PATCH 200（user + tripId；ops token 免 tripId）', async () => {
    const id = await seedTripPoi('patch');
    const res = await req('PATCH', POI, `/api/pois/${id}`, { as: owner, json: { tripId: TRIP, note: '新備註', rating: 4.2, price: '¥200' } });
    expect(res.status).toBe(200);
    const row = await res.json() as { note: string; price: unknown };
    expectContract(S.Pois_PoiRow, row); expect(row.note).toBe('新備註'); expect(row.price).toBe('¥200');
    const ops = await req('PATCH', POI, `/api/pois/${id}`, { bearer: await serviceToken(db, ['ops:poi'], 'poi-cli'), json: { hours: '09:00-18:00' } });
    expect(ops.status).toBe(200); expectContract(S.Pois_PoiRow, await ops.json());
  });
  it('PATCH 400／401／403／404', async () => {
    const id = await seedTripPoi('patch2');
    await apiErr(await req('PATCH', POI, '/api/pois/abc', { as: owner, json: { tripId: TRIP, note: 'x' } }), 'DATA_VALIDATION');
    await apiErr(await req('PATCH', POI, `/api/pois/${id}`, { as: owner, json: { tripId: TRIP, bogus: 1 } }), 'DATA_VALIDATION');
    const anon = await req('PATCH', POI, `/api/pois/${id}`, { json: { note: 'x' } });
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const denied = await req('PATCH', POI, `/api/pois/${id}`, { as: stranger, json: { tripId: TRIP, note: 'x' } });
    expect(denied.status).toBe(403); await apiErr(denied, 'PERM_DENIED');
    const nf = await req('PATCH', POI, '/api/pois/987654', { as: owner, json: { tripId: TRIP, note: 'x' } });
    expect(nf.status).toBe(404); await apiErr(nf, 'DATA_NOT_FOUND');
  });

  it('DELETE 200（ops:poi）', async () => {
    const id = await seedTripPoi('del');
    const res = await req('DELETE', POI, `/api/pois/${id}`, { bearer: await serviceToken(db, ['ops:poi'], 'poi-cli') });
    expect(res.status).toBe(200);
    const body = await res.json() as { deletedTripEntryPois: number };
    expectContract(S.Pois_DeleteResponse, body); expect(body.deletedTripEntryPois).toBe(1);
  });
  it('DELETE 400／401／403／404', async () => {
    const ops = await serviceToken(db, ['ops:poi'], 'poi-cli');
    await apiErr(await req('DELETE', POI, '/api/pois/abc', { bearer: ops }), 'DATA_VALIDATION');
    const anon = await req('DELETE', POI, '/api/pois/1', {});
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const denied = await req('DELETE', POI, '/api/pois/1', { as: owner });
    expect(denied.status).toBe(403); await apiErr(denied, 'PERM_DENIED');
    const nf = await req('DELETE', POI, '/api/pois/987654', { bearer: ops });
    expect(nf.status).toBe(404); await apiErr(nf, 'DATA_NOT_FOUND');
  });

  it('enrich 200（active／closed／missing 三種）', async () => {
    const a = await seedTripPoi('enrich-a', 'ChIJ_ea');
    google.respond(() => jsonOk(placeDetails()));
    const ok = await req('POST', ENR, `/api/pois/${a}/enrich?tripId=${TRIP}`, { as: owner });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { status: string };
    expectContract(S.Pois_EnrichResponse, body); expect(body.status).toBe('active');
    google.respond(() => jsonOk(placeDetails({ businessStatus: 'CLOSED_PERMANENTLY' })));
    const closed = await (await req('POST', ENR, `/api/pois/${a}/enrich?tripId=${TRIP}`, { as: owner })).json() as { status: string };
    expectContract(S.Pois_EnrichResponse, closed); expect(closed.status).toBe('closed');
    google.respond(() => new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 }));
    const missing = await (await req('POST', ENR, `/api/pois/${a}/enrich`, { bearer: await serviceToken(db, ['ops:poi'], 'poi-cli') })).json() as { status: string; rating: unknown };
    expectContract(S.Pois_EnrichResponse, missing); expect(missing.status).toBe('missing'); expect(missing.rating).toBeNull();
  });
  it('enrich 400／401／403／404／502／503', async () => {
    const ops = await serviceToken(db, ['ops:poi'], 'poi-cli');
    const noPlace = await seedTripPoi('enrich-np', null);
    const withPlace = await seedTripPoi('enrich-wp', 'ChIJ_wp');
    await apiErr(await req('POST', ENR, '/api/pois/abc/enrich', { bearer: ops }), 'DATA_VALIDATION');
    await apiErr(await req('POST', ENR, `/api/pois/${noPlace}/enrich`, { bearer: ops }), 'DATA_VALIDATION');
    const anon = await req('POST', ENR, `/api/pois/${withPlace}/enrich`, {});
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
    const denied = await req('POST', ENR, `/api/pois/${withPlace}/enrich?tripId=${TRIP}`, { as: stranger });
    expect(denied.status).toBe(403); await apiErr(denied, 'PERM_DENIED');
    const nf = await req('POST', ENR, '/api/pois/987654/enrich', { bearer: ops });
    expect(nf.status).toBe(404); await apiErr(nf, 'DATA_NOT_FOUND');
    google.respond(() => jsonOk(placeDetails(), 503));
    const up = await req('POST', ENR, `/api/pois/${withPlace}/enrich`, { bearer: ops });
    expect(up.status).toBe(502); await apiErr(up, 'MAPS_UPSTREAM_FAILED');
    await lockMaps();
    try { const locked = await req('POST', ENR, `/api/pois/${withPlace}/enrich`, { bearer: ops }); expect(locked.status).toBe(503); await apiErr(locked, 'MAPS_LOCKED'); } finally { await unlockMaps(); }
  });

  it('find-or-create 200（新建與命中既有都回 200 + { id }）／400／401', async () => {
    const first = await req('POST', FOC, '/api/pois/find-or-create', { as: owner, json: { name: 'pp-foc', type: 'restaurant', lat: 25, lng: 121, place_id: 'ChIJ_foc' } });
    expect(first.status).toBe(200);
    const a = await first.json() as { id: number };
    expectContract(S.Pois_FindOrCreateResponse, a);
    const again = await (await req('POST', FOC, '/api/pois/find-or-create', { as: owner, json: { name: 'pp-foc', type: 'restaurant' } })).json() as { id: number };
    expect(again.id).toBe(a.id);
    await apiErr(await req('POST', FOC, '/api/pois/find-or-create', { as: owner, json: { type: 'restaurant' } }), 'DATA_VALIDATION');
    const anon = await req('POST', FOC, '/api/pois/find-or-create', { json: { name: 'x', type: 'restaurant' } });
    expect(anon.status).toBe(401); await apiErr(anon, 'AUTH_REQUIRED');
  });
});

describe('route（公開）', () => {
  const IP = '198.51.100.91';
  const route = (qs: string, ip = IP, client: Api = api) => client.get(`${ROUTE}?${qs}`, { headers: { 'CF-Connecting-IP': ip } }).then((r) => hit(key('get', ROUTE), r));
  const Q = 'from=139.7454,35.6586&to=139.7671,35.6812';
  it('200', async () => {
    google.respond(() => jsonOk({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' }, duration: '60s', distanceMeters: 100 }] }));
    const res = await route(Q);
    expect(res.status).toBe(200);
    const body = await res.json() as { polyline: unknown[]; duration: number; distance: number };
    expectContract(S.Pois_RouteResponse, body);
    expect(body.polyline.length).toBe(2); expect(body.duration).toBe(60); expect(body.distance).toBe(100);
  });
  it('400／429／502／503', async () => {
    await apiErr(await route('from=abc&to=1,2'), 'DATA_VALIDATION');
    await lockBucket(`route:ip:${IP}2`);
    const limited = await route(Q, `${IP}2`);
    expect(limited.status).toBe(429); await apiErr(limited, 'RATE_LIMITED');
    const noKey = await route(Q, `${IP}3`, noKeyApi()); expect(noKey.status).toBe(502); await apiErr(noKey, 'MAPS_UPSTREAM_FAILED');
    await lockMaps();
    try { const locked = await route(Q, `${IP}4`); expect(locked.status).toBe(503); await apiErr(locked, 'MAPS_LOCKED'); } finally { await unlockMaps(); }
  });
});

describe('public-config（公開）', () => {
  it('200', async () => {
    const res = hit(key('get', CFG), await api.get(CFG));
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: { google: boolean } };
    expectContract(S.Pois_PublicConfigResponse, body);
    expect(body.providers.google).toBe(true);
  });
});

describe('請求 body 的 schema 與 handler 一致', () => {
  /** 送出的 body 必須符合文件的 body schema；handler 拒絕的 body，文件的 schema 也要判定不合法。 */
  const accepted = (schema: Parameters<typeof expectContract>[0], body: unknown) => expectContract(schema, body);
  const rejected = (schema: Parameters<typeof expectContract>[0], body: unknown) => expect(contractIssues(schema, body).length).toBeGreaterThan(0);

  it('autocomplete body', async () => {
    google.respond(() => jsonOk({ suggestions: [] }));
    const ok = { q: '高雄市', sessionToken: 'tok', regionCode: 'tw' };
    accepted(S.Pois_AutocompleteBody, ok);
    expect((await api.request('POST', AC, { as: owner, json: ok })).status).toBe(200);
    for (const bad of [{ q: 'x', sessionToken: 't' }, { q: '高雄市' }, { q: '高雄市', sessionToken: 't', regionCode: 'toolongcode' }, { q: 'a'.repeat(201), sessionToken: 't' }]) {
      rejected(S.Pois_AutocompleteBody, bad);
      expect((await api.request('POST', AC, { as: owner, json: bad })).status).toBe(400);
    }
  });
  it('poi-favorites POST body', async () => {
    const poiId = await seedPoi(db, { name: 'pp-body-fav' });
    const ok = { poiId, note: 'n' };
    accepted(S.Pois_FavoriteCreateBody, ok);
    expect((await api.request('POST', FAVS, { as: other, json: ok, headers: { 'CF-Connecting-IP': '198.51.100.72' } })).status).toBe(201);
    for (const bad of [{ poiId: 'x' }, { poiId: 0 }, { poiId: 1.5 }, {}]) {
      rejected(S.Pois_FavoriteCreateBody, bad);
      expect((await api.request('POST', FAVS, { as: other, json: bad, headers: { 'CF-Connecting-IP': '198.51.100.72' } })).status).toBe(400);
    }
  });
  it('add-to-trip body', async () => {
    const { favId } = await seedFavorite(owner, 'body-att');
    const url = `${FAVS}/${favId}/add-to-trip`;
    const h = { 'CF-Connecting-IP': '198.51.100.73' };
    const ok = { tripId: TRIP, dayNum: 3, startTime: '15:00', endTime: '16:00' };
    accepted(S.Pois_AddToTripBody, ok);
    expect((await api.request('POST', url, { as: owner, json: ok, headers: h })).status).toBe(201);
    for (const bad of [{ ...ok, tripId: undefined }, { ...ok, dayNum: 0 }, { ...ok, startTime: '9:00' }, { ...ok, endTime: 'noon' }, { ...ok, position: 'after' }]) {
      rejected(S.Pois_AddToTripBody, bad);
      expect((await api.request('POST', url, { as: owner, json: bad, headers: h })).status).toBe(400);
    }
  });
  it('find-or-create body', async () => {
    const ok = { name: 'pp-body-foc', type: 'restaurant', description: 'd', lat: 25, lng: 121, address: 'a', category: 'c', source: 's', country: 'JP', place_id: 'ChIJ_body' };
    accepted(S.Pois_FindOrCreateBody, ok);
    expect((await api.request('POST', FOC, { as: owner, json: ok })).status).toBe(200);
    for (const bad of [{ type: 'restaurant' }, { name: 'x' }, { name: '  ', type: 'restaurant' }]) {
      rejected(S.Pois_FindOrCreateBody, bad);
      expect((await api.request('POST', FOC, { as: owner, json: bad })).status).toBe(400);
    }
  });
  it('PATCH body：全部欄位送出並讀回非 null 的值', async () => {
    const id = await seedTripPoi('body-patch');
    const ok = {
      tripId: TRIP, name: 'pp-body-patch2', description: 'd', note: 'n', address: 'addr', phone: '02-1234', email: 'a@b.c', website: 'https://x.test',
      hours: '09:00', rating: 4.1, price: '¥500', category: 'cafe', lat: 25.1, lng: 121.2, country: 'TW', source: 'ai', place_id: 'ChIJ_pb',
      status: 'closed', status_reason: '歇業', status_checked_at: '2026-01-01', last_refreshed_at: '2026-01-02', data_source: 'google',
      osm_id: 123, osm_type: 'node', wikidata_id: 'Q1', cuisine: 'ramen',
    };
    accepted(S.Pois_PatchBody, ok);
    const res = await api.request('PATCH', `/api/pois/${id}`, { as: owner, json: ok });
    expect(res.status).toBe(200);
    const row = await res.json() as Record<string, unknown>;
    expectContract(S.Pois_PoiRow, row);
    expect(row).toMatchObject({ price: '¥500', osmType: 'node', osmId: 123, wikidataId: 'Q1', cuisine: 'ramen', dataSource: 'google', placeId: 'ChIJ_pb', status: 'closed', statusReason: '歇業', lat: 25.1, rating: 4.1, email: 'a@b.c' });
    // handler 拒絕（沒有任何白名單欄位）→ 文件的 body schema（strict）也判不合法
    const bad = { tripId: TRIP, bogus: 1 };
    rejected(S.Pois_PatchBody, bad);
    expect((await api.request('PATCH', `/api/pois/${id}`, { as: owner, json: bad })).status).toBe(400);
    rejected(S.Pois_PatchBody, { tripId: TRIP, price: 5 });
  });
});

describe('文件覆蓋（路由都有文件）', () => {
  let spec: { paths: Record<string, Record<string, { requestBody?: unknown; responses?: Record<string, { content?: unknown; description?: string }>; security?: unknown[] }>> };
  beforeAll(async () => { spec = (await (await api.get('/openapi.json')).json()) as typeof spec; });

  it.each(ROUTES)('$method $path 有完整文件', ({ method, path, auth, body }) => {
    const op = spec.paths[path]?.[method];
    expect(op, '路由必須出現在 /openapi.json').toBeTruthy();
    if (body) expect(op!.requestBody, '寫入類路由要有 requestBody').toBeTruthy();
    const responses = Object.values(op!.responses ?? {});
    expect(responses.length).toBeGreaterThan(0);
    // 至少一個回應有 schema，或明確是無 JSON 內容的回應（description 具體、不是預設的「依端點而定」）
    expect(responses.some((r) => r.content || (r.description && !r.description.includes('依端點而定')))).toBe(true);
    // 預設文件只有一個 200 且內容是 any → 視為沒寫
    const codes = Object.keys(op!.responses ?? {});
    expect(codes.length === 1 && codes[0] === '200' && (op!.responses!['200']!.description ?? '').includes('依端點而定')).toBe(false);
    if (auth === 'required') expect(op!.security).toEqual([{ bearerAuth: [] }]);
    else expect(op!.security).toBeUndefined();
    // 契約：路由有寫的每個狀態碼，都要有測試實際觸發過
    for (const code of codes) expect(hits.has(`${key(method, path)} ${code}`), `文件列了 ${code} 但沒有測試觸發`).toBe(true);
  });
});
