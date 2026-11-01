/**
 * Integration test — Google APIs endpoints (v2.34.37 PR37)
 *
 * 涵蓋 PR35 doc 標 P0 HIGH risk 兩個 endpoint：
 *   - GET /api/poi-search — Places Text Search (with D1 24h cache)
 *   - GET /api/route — Routes API (DRIVE mode)
 *
 * 走 HTTP 邊界（tests/api/http.ts）；Google 是外部邊界，用 tests/api/google-stub.ts
 * 攔截 global fetch —— 不 mock google-client 模組，所以 field mask、method、金鑰 header、
 * request body 與對回應的處理都是真實 google-client 的行為，並在這裡明確斷言。
 * 共用 D1：專屬 IP（rate-limit bucket）與 `s10-` 前綴的 query（快取列），結束時清掉。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { stubGoogle, jsonOk } from './google-stub';
import { invalidateLockCache } from '../../src/lib/maps-lock';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const google = stubGoogle();

const SEARCH_IP = '203.0.113.101';
const ROUTE_IP = '203.0.113.102';
const API_KEY = 'test-api-key';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: API_KEY });
  api = createApi({ env });
});

afterAll(async () => {
  google.restore();
  await db.prepare("DELETE FROM pois_search_cache WHERE query_text LIKE 's10-%'").run();
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'poi-search:ip:203.0.113.%' OR bucket_key LIKE 'route:ip:203.0.113.%'").run();
  await db.prepare("DELETE FROM app_settings WHERE key IN ('google_maps_locked', 'google_maps_locked_reason')").run();
  invalidateLockCache();
  await disposeMiniflare();
});

beforeEach(() => {
  google.reset();
});

function callPoiSearch(searchParams: string, ip = SEARCH_IP) {
  return api.get(`/api/poi-search?${searchParams}`, { headers: { 'CF-Connecting-IP': ip } });
}

function callRoute(searchParams: string, ip = ROUTE_IP) {
  return api.get(`/api/route?${searchParams}`, { headers: { 'CF-Connecting-IP': ip } });
}

const placesPage = (places: unknown[], nextPageToken?: string) => jsonOk({ places, nextPageToken });

describe('GET /api/poi-search — validation + rate limit + Google 請求', () => {
  it('query < 2 字元 → 400 DATA_VALIDATION', async () => {
    const res = await callPoiSearch('q=a');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('query > 200 字元 → 400 DATA_VALIDATION', async () => {
    const res = await callPoiSearch(`q=${'x'.repeat(201)}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.detail).toContain('200');
  });

  it('q 缺失 → 400', async () => {
    const res = await callPoiSearch('region=JP');
    expect(res.status).toBe(400);
  });

  it('正常 query → call Places searchText + 200 response + X-Cache=MISS', async () => {
    google.respond(() => placesPage([
      {
        id: 'ChIJxxx',
        displayName: { text: '東京鐵塔' },
        formattedAddress: '東京都港区芝公園',
        location: { latitude: 35.6586, longitude: 139.7454 },
        primaryType: 'TOURIST_ATTRACTION',
        addressComponents: [{ shortText: 'JP', longText: '日本', types: ['country'] }],
        rating: 4.4,
      },
    ]));
    const res = await callPoiSearch('q=s10-東京鐵塔&region=JP&limit=5');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('MISS');
    const body = await res.json() as { results: Array<{ name: string; place_id: string; country: string }> };
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.name).toBe('東京鐵塔');
    expect(body.results[0]!.place_id).toBe('ChIJxxx');
    expect(body.results[0]!.country).toBe('JP');

    // 送給 Google 的請求：POST searchText、金鑰在 header（不在 URL）、field mask 含 nextPageToken
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(call.url).not.toContain(API_KEY);
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
    const mask = call.headers.get('X-Goog-FieldMask')!.split(',');
    expect(mask).toEqual(expect.arrayContaining(['nextPageToken', 'places.id', 'places.displayName', 'places.location']));
    expect(call.body).toMatchObject({ textQuery: 's10-東京鐵塔', maxResultCount: 5, languageCode: 'zh-TW', regionCode: 'jp' });
    expect(call.body).not.toHaveProperty('pageToken');
    // 回應內容不洩漏金鑰
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('第二次相同查詢 → 命中 D1 快取（X-Cache=HIT），不再打 Google', async () => {
    google.respond(() => placesPage([
      { id: 'ChIJcache', displayName: { text: '快取地點' }, location: { latitude: 1, longitude: 2 } },
    ]));
    const first = await callPoiSearch('q=s10-快取命中&region=JP');
    expect(first.headers.get('X-Cache')).toBe('MISS');
    // waitUntil 的快取寫入由 http.ts 在回應前等完
    const second = await callPoiSearch('q=s10-快取命中&region=JP');
    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(google.calls).toHaveLength(1);
    const body = await second.json() as { results: Array<{ name: string }>; nextPageToken: string | null };
    expect(body.results[0]!.name).toBe('快取地點');
    expect(body.nextPageToken).toBeNull();
  });

  it('limit clamp 到 [1, 20]', async () => {
    google.respond(() => placesPage([]));
    await callPoiSearch('q=s10-limit-high&limit=999');
    expect(google.calls[0]!.body!.maxResultCount).toBe(20);
    await callPoiSearch('q=s10-limit-low&limit=0');
    // limit=0 走預設 10（parseInt 結果為 0 → falsy → 10）
    expect(google.calls[1]!.body!.maxResultCount).toBe(10);
    await callPoiSearch('q=s10-limit-neg&limit=-5');
    expect(google.calls[2]!.body!.maxResultCount).toBe(1);
  });

  it('回應帶 nextPageToken，讓前端知道還有沒有下一頁', async () => {
    google.respond(() => placesPage([], 'TOK_2'));
    const res = await callPoiSearch('q=s10-分頁測試&region=JP');
    const body = await res.json() as { nextPageToken: string | null };
    expect(body.nextPageToken).toBe('TOK_2');
  });

  it('帶 pageToken 時把它傳給 Google 且不寫快取（否則第 2 頁會污染首次搜尋）', async () => {
    google.respond(() => placesPage([], undefined));
    await callPoiSearch('q=s10-快取污染測試&region=JP&pageToken=TOK_2');
    expect(google.calls[0]!.body!.pageToken).toBe('TOK_2');

    // 同一組 (q, region) 再打一次「首次搜尋」—— 若第 2 頁寫進了快取，這裡會是 HIT
    // 且拿到第 2 頁內容。應為 MISS，且真的再打了一次 Google。
    const res2 = await callPoiSearch('q=s10-快取污染測試&region=JP');
    expect(res2.headers.get('X-Cache')).toBe('MISS');
    expect(google.calls).toHaveLength(2);
    expect(google.calls[1]!.body).not.toHaveProperty('pageToken');
  });

  it('Google 回 503 → 502 MAPS_UPSTREAM_FAILED（走 middleware 的結構化錯誤）', async () => {
    // 回應本體是合法的結果 JSON，只有狀態碼是 503 —— 只認狀態碼的實作才不會被本體誤導
    google.respond(() => jsonOk({
      places: [{ id: 'ChIJerr', displayName: { text: '不該被採用' }, location: { latitude: 1, longitude: 2 } }],
    }, 503));
    const res = await callPoiSearch('q=s10-test-err&region=JP');
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MAPS_UPSTREAM_FAILED');
  });

  it('GOOGLE_MAPS_API_KEY 缺失 → 502，且不打 Google', async () => {
    const noKey = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: '' }) });
    const res = await noKey.get('/api/poi-search?q=s10-no-key', { headers: { 'CF-Connecting-IP': SEARCH_IP } });
    expect(res.status).toBe(502);
    expect(google.calls).toHaveLength(0);
  });

  it('kill switch 啟用 → 503 MAPS_LOCKED，且不打 Google', async () => {
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
    invalidateLockCache();
    try {
      const res = await callPoiSearch('q=s10-locked');
      expect(res.status).toBe(503);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('MAPS_LOCKED');
      expect(google.calls).toHaveLength(0);
    } finally {
      await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
      invalidateLockCache();
    }
  });

  it('同一 IP 超過上限 → 429 RATE_LIMITED + Retry-After，且不打 Google', async () => {
    const ip = '203.0.113.103';
    await db.prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until`,
    ).bind(`poi-search:ip:${ip}`, 1001, Date.now(), Date.now() + 3600_000).run();
    const res = await callPoiSearch('q=s10-rate', ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(google.calls).toHaveLength(0);
  });
});

describe('GET /api/route — validation + Google 請求', () => {
  it('缺 from / to → 400 DATA_VALIDATION', async () => {
    const res = await callRoute('from=139.7,35.6');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('座標超出範圍 → 400', async () => {
    const res = await callRoute('from=999,35.6&to=139.8,35.7');
    expect(res.status).toBe(400);
  });

  it('正常 coords → call computeRoutes + 200 + decode polyline + duration / distance', async () => {
    google.respond(() => jsonOk({
      routes: [{
        polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, // sample encoded polyline
        duration: '1234s',
        distanceMeters: 56789,
      }],
    }));
    const res = await callRoute('from=139.7,35.6&to=139.8,35.7');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      polyline: Array<[number, number]>;
      duration: number;
      distance: number;
    };
    expect(Array.isArray(body.polyline)).toBe(true);
    expect(body.polyline.length).toBeGreaterThan(0);
    // Google 範例 polyline 的第一個點是 (38.5, -120.2)
    expect(body.polyline[0]).toEqual([38.5, -120.2]);
    expect(body.duration).toBe(1234);
    expect(body.distance).toBe(56789);

    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(call.url).not.toContain(API_KEY);
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
    expect(call.headers.get('X-Goog-FieldMask')).toBe('routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration');
    // mode 應為 DRIVE (v2.30.0 default)；from=lng,lat → latitude/longitude 不可對調
    expect(call.body).toMatchObject({
      travelMode: 'DRIVE',
      origin: { location: { latLng: { latitude: 35.6, longitude: 139.7 } } },
      destination: { location: { latLng: { latitude: 35.7, longitude: 139.8 } } },
    });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('Google 回 503 → 502 MAPS_UPSTREAM_FAILED', async () => {
    google.respond(() => jsonOk({
      routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U' }, duration: '100s', distanceMeters: 500 }],
    }, 503));
    const res = await callRoute('from=139.7,35.6&to=139.8,35.7');
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MAPS_UPSTREAM_FAILED');
  });

  it('Cache-Control: public, max-age=86400 (24h edge cache)', async () => {
    google.respond(() => jsonOk({
      routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U' }, duration: '100s', distanceMeters: 500 }],
    }));
    const res = await callRoute('from=139.7,35.6&to=139.8,35.7');
    expect(res.headers.get('Cache-Control')).toMatch(/public.*86400/);
  });

  it('kill switch 啟用 → 503 MAPS_LOCKED，且不打 Google', async () => {
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
    invalidateLockCache();
    try {
      const res = await callRoute('from=139.7,35.6&to=139.8,35.7');
      expect(res.status).toBe(503);
      expect(google.calls).toHaveLength(0);
    } finally {
      await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
      invalidateLockCache();
    }
  });
});

describe('PR35 P0 HIGH gap — source-grep regression', () => {
  it('poi-search.ts 仍 import searchPlaces from google-client', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(join(__dirname, '..', '..', 'src/routes/handlers/poi-search.ts'), 'utf8');
    expect(src).toMatch(/import\s+\{[^}]*searchPlaces[^}]*\}\s+from\s+['"][^'"]*google-client['"]/);
  });

  it('route.ts 仍 import computeRoute from google-client', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(join(__dirname, '..', '..', 'src/routes/handlers/route.ts'), 'utf8');
    expect(src).toMatch(/import\s+\{[^}]*computeRoute[^}]*\}\s+from\s+['"][^'"]*google-client['"]/);
  });
});
