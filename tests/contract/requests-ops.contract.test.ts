/**
 * requests-ops 組的契約測試：實際回應必須符合文件宣告的 schema（多出欄位也算失敗）。
 * 走 HTTP 邊界；Google／GCP 是外部邊界，全域 fetch 一律攔截，只回測試提供的內容，不會真的連線。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { serviceToken } from '../baseline/service-token';
import { _resetGcpTokenCacheForTest } from '../../src/lib/gcp-monitoring';
import type { Env } from '../../src/env';
import { ApiError } from '../../src/schemas/common';
import { expectContract } from './support';
import {
  Admin_BackfillStatus, Admin_CacheCleanup, Admin_MapsLock, Admin_MapsSettings, Admin_MapsUnlock,
  Admin_PoisDueRefresh, Admin_PoisPendingPlaceId, Admin_QuotaEstimate,
  Reports_Ok, Requests_ListResponse, Requests_Row, Requests_RowWithName,
} from '../../src/schemas/requests-ops';

const TRIP = 'ct-reqops-trip';
const OWNER = 'ct-reqops-owner@test.com';
const STRANGER = 'ct-reqops-stranger@test.com';

let db: D1Database;
let api: Api;
let companion: string;
let opsMaps: string;
let opsPoi: string;
let opsCache: string;
let saKeyJson: string;
let monitoringStatus = 500;

async function makeServiceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n');
  const dash = '-----';
  return JSON.stringify({
    type: 'service_account', project_id: 'ct-project', private_key_id: 'kid-ct',
    private_key: [`${dash}BEGIN PRIVATE KEY${dash}`, b64, `${dash}END PRIVATE KEY${dash}`, ''].join('\n'),
    client_email: 'ct-sa.iam.invalid',
  });
}

/** 只放行 GCP 的兩個網域（由測試給回應）；其他一律丟錯，確保不會真的連線。 */
function stubGcp() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    if (host === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (host === 'monitoring.googleapis.com') {
      if (monitoringStatus !== 200) return new Response('{}', { status: monitoringStatus });
      return new Response(JSON.stringify({ timeSeries: [{ resource: { labels: { service: 'places.googleapis.com', method: 'google.maps.places.v1.Places.SearchText' } }, points: [{ value: { int64Value: '12' } }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`測試不應對外發請求：${url}`);
  });
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' }) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
  companion = await serviceToken(db, ['companion']);
  opsMaps = await serviceToken(db, ['ops:maps']);
  opsPoi = await serviceToken(db, ['ops:poi']);
  opsCache = await serviceToken(db, ['ops:cache']);
  saKeyJson = await makeServiceAccountJson();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeMiniflare();
});

beforeEach(() => {
  _resetGcpTokenCacheForTest();
  monitoringStatus = 500;
  stubGcp();
});

const errorOf = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  expectContract(ApiError, await res.json());
};

describe('requests', () => {
  let requestId: number;

  it('POST /api/requests 201：回傳 trip_requests 資料列', async () => {
    const res = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: '契約測試請求' } });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: number };
    expectContract(Requests_Row, body);
    requestId = body.id;
  });

  it('POST /api/requests 200：30 秒內相同請求去重，回既有資料列', async () => {
    const res = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: '契約測試請求' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: number };
    expectContract(Requests_Row, body);
    expect(body.id).toBe(requestId);
  });

  it('POST /api/requests 400／401／403', async () => {
    await errorOf(await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP } }), 400);
    await errorOf(await api.request('POST', '/api/requests', { headers: { Origin: 'https://trip-planner-dby.pages.dev' }, json: { tripId: TRIP, message: 'x' } }), 401);
    await errorOf(await api.request('POST', '/api/requests', { as: STRANGER, json: { tripId: TRIP, message: 'x' } }), 403);
  });

  it('GET /api/requests 200（不分頁）：陣列，含 submitted_by_display_name', async () => {
    const res = await api.get(`/api/requests?tripId=${TRIP}`, { as: OWNER });
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expectContract(Requests_ListResponse, body);
  });

  it('GET /api/requests 200（分頁）：{ items, hasMore }', async () => {
    const res = await api.get(`/api/requests?tripId=${TRIP}&limit=1&sort=asc`, { as: OWNER });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; hasMore: boolean };
    expect(Array.isArray(body.items)).toBe(true);
    expectContract(Requests_ListResponse, body);
  });

  it('GET /api/requests 400／401／403', async () => {
    await errorOf(await api.get('/api/requests', { as: OWNER }), 400);
    await errorOf(await api.get(`/api/requests?tripId=${TRIP}`), 401);
    await errorOf(await api.get(`/api/requests?tripId=${TRIP}`, { as: STRANGER }), 403);
  });

  it('GET /api/requests/:id 200／401／403／404', async () => {
    const res = await api.get(`/api/requests/${requestId}`, { as: OWNER });
    expect(res.status).toBe(200);
    expectContract(Requests_RowWithName, await res.json());
    await errorOf(await api.get(`/api/requests/${requestId}`), 401);
    await errorOf(await api.get(`/api/requests/${requestId}`, { as: STRANGER }), 403);
    await errorOf(await api.get('/api/requests/999999', { as: OWNER }), 404);
  });

  it('PATCH /api/requests/:id 200：companion service token 成功（status／reply／processed_by）', async () => {
    const res = await api.request('PATCH', `/api/requests/${requestId}`, { bearer: companion, json: { status: 'processing', reply: '處理中', processed_by: 'job' } });
    expect(res.status).toBe(200);
    expectContract(Requests_Row, await res.json());
  });

  it('PATCH /api/requests/:id 200：有寫權的 owner 也可；終結帶 terminalReason', async () => {
    const res = await api.request('PATCH', `/api/requests/${requestId}`, { as: OWNER, json: { status: 'failed', terminalReason: 'cancelled' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; terminalReason: string };
    expectContract(Requests_Row, body);
    expect(body.terminalReason).toBe('cancelled');
  });

  it('PATCH /api/requests/:id 400／401／403／404', async () => {
    await errorOf(await api.request('PATCH', `/api/requests/${requestId}`, { bearer: companion, json: { status: 'bogus' } }), 400);
    await errorOf(await api.request('PATCH', `/api/requests/${requestId}`, { headers: { Origin: 'https://trip-planner-dby.pages.dev' }, json: { reply: 'x' } }), 401);
    // gate：沒有 companion scope 又沒有該 trip 寫權 → 403（陌生 user、只有 ops:maps 的 service token）
    await errorOf(await api.request('PATCH', `/api/requests/${requestId}`, { as: STRANGER, json: { reply: 'x' } }), 403);
    await errorOf(await api.request('PATCH', `/api/requests/${requestId}`, { bearer: opsMaps, json: { reply: 'x' } }), 403);
    await errorOf(await api.request('PATCH', '/api/requests/999999', { bearer: companion, json: { reply: 'x' } }), 404);
  });
});

describe('reports（公開）', () => {
  const post = (json: unknown, ip = '10.77.0.1') =>
    api.request('POST', '/api/reports', { json, headers: { Origin: 'https://trip-planner-dby.pages.dev', 'CF-Connecting-IP': ip } });

  it('201：寫入回報', async () => {
    const res = await post({ tripId: TRIP, url: 'https://x/ct', errorCode: 'SYS_INTERNAL', errorMessage: 'm', userAgent: 'ua', context: 'c' });
    expect(res.status).toBe(201);
    expectContract(Reports_Ok, await res.json());
  });

  it('200：蜜罐欄位假裝成功', async () => {
    const res = await post({ tripId: TRIP, website: 'spam' });
    expect(res.status).toBe(200);
    expectContract(Reports_Ok, await res.json());
  });

  it('400／429（重複與 IP 鎖定兩種）', async () => {
    await errorOf(await post({ url: 'x' }), 400);
    await errorOf(await post({ tripId: TRIP, url: 'https://x/ct' }), 429); // 30 秒內同 trip + url
    await db.prepare('INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
      .bind('reports:ip:10.77.0.9', 201, Date.now(), Date.now() + 60_000).run();
    await errorOf(await post({ tripId: TRIP, url: 'https://x/locked' }, '10.77.0.9'), 429);
  });
});

describe('admin（需對應 ops scope 的 service token）', () => {
  it('GET /api/admin/backfill-status（ops:poi）200／401／403', async () => {
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_migration_applied_at', '2026-01-01T00:00:00Z')").run();
    const res = await api.get('/api/admin/backfill-status', { bearer: opsPoi });
    expect(res.status).toBe(200);
    expectContract(Admin_BackfillStatus, await res.json());
    await errorOf(await api.get('/api/admin/backfill-status'), 401);
    await errorOf(await api.get('/api/admin/backfill-status', { bearer: opsMaps }), 403);
  });

  it('GET /api/admin/pois-due-refresh（ops:poi）200／403', async () => {
    await db.prepare("INSERT INTO pois (type, name, place_id, status) VALUES ('restaurant', 'due', 'pid-1', 'active')").run();
    const res = await api.get('/api/admin/pois-due-refresh?limit=5', { bearer: opsPoi });
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expectContract(Admin_PoisDueRefresh, body);
    await errorOf(await api.get('/api/admin/pois-due-refresh', { bearer: opsCache }), 403);
    await errorOf(await api.get('/api/admin/pois-due-refresh'), 401);
  });

  it('GET /api/admin/pois-pending-place-id（ops:poi）200／403', async () => {
    await db.prepare("INSERT INTO pois (type, name) VALUES ('restaurant', 'pending')").run();
    const res = await api.get('/api/admin/pois-pending-place-id?limit=5', { bearer: opsPoi });
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expectContract(Admin_PoisPendingPlaceId, body);
    await errorOf(await api.get('/api/admin/pois-pending-place-id', { bearer: opsMaps }), 403);
    await errorOf(await api.get('/api/admin/pois-pending-place-id'), 401);
  });

  it('POST /api/admin/cache-cleanup（ops:cache）200／403', async () => {
    const res = await api.request('POST', '/api/admin/cache-cleanup', { bearer: opsCache });
    expect(res.status).toBe(200);
    expectContract(Admin_CacheCleanup, await res.json());
    await errorOf(await api.request('POST', '/api/admin/cache-cleanup', { bearer: opsPoi }), 403);
    await errorOf(await api.request('POST', '/api/admin/cache-cleanup', { headers: { Origin: 'https://trip-planner-dby.pages.dev' } }), 401);
  });

  it('maps-lock／maps-settings／maps-unlock（ops:maps）200／403', async () => {
    const lock = await api.request('POST', '/api/admin/maps-lock', { bearer: opsMaps, json: { reason: '契約測試' } });
    expect(lock.status).toBe(200);
    expectContract(Admin_MapsLock, await lock.json());

    const locked = await api.get('/api/admin/maps-settings', { bearer: opsMaps });
    expect(locked.status).toBe(200);
    const lockedBody = await locked.json() as { is_locked: boolean };
    expect(lockedBody.is_locked).toBe(true);
    expectContract(Admin_MapsSettings, lockedBody);

    const unlock = await api.request('POST', '/api/admin/maps-unlock', { bearer: opsMaps });
    expect(unlock.status).toBe(200);
    expectContract(Admin_MapsUnlock, await unlock.json());

    await errorOf(await api.request('POST', '/api/admin/maps-lock', { bearer: opsPoi }), 403);
    await errorOf(await api.request('POST', '/api/admin/maps-unlock', { bearer: opsPoi }), 403);
    await errorOf(await api.get('/api/admin/maps-settings', { bearer: opsPoi }), 403);
    await errorOf(await api.get('/api/admin/maps-settings'), 401);
  });

  it('GET /api/admin/quota-estimate（ops:maps）200（GCP 用 stub）／502／403', async () => {
    const configured = createApi({ env: mockEnv(db, { GOOGLE_CLOUD_SA_KEY: saKeyJson, GOOGLE_CLOUD_PROJECT_ID: 'ct-proj' }) });
    monitoringStatus = 200;
    const ok = await configured.get('/api/admin/quota-estimate', { bearer: opsMaps });
    expect(ok.status).toBe(200);
    const body = await ok.json() as unknown[];
    expect(body.length).toBe(1);
    expectContract(Admin_QuotaEstimate, body);

    _resetGcpTokenCacheForTest();
    monitoringStatus = 500;
    await errorOf(await configured.get('/api/admin/quota-estimate', { bearer: opsMaps }), 502);
    await errorOf(await configured.get('/api/admin/quota-estimate', { bearer: opsPoi }), 403);
    await errorOf(await configured.get('/api/admin/quota-estimate'), 401);
  });
});

describe('/openapi.json 對這組每條路由的描述', () => {
  type Op = { requestBody?: unknown; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>; security?: unknown[]; summary?: string; parameters?: { name: string; in: string }[] };
  const routes: Array<{ method: string; path: string; auth: 'required' | 'none'; body: boolean; ok: number[]; scope?: string; query?: string[] }> = [
    { method: 'get', path: '/api/requests', auth: 'required', body: false, ok: [200], query: ['tripId', 'limit'] },
    { method: 'post', path: '/api/requests', auth: 'required', body: true, ok: [200, 201] },
    { method: 'get', path: '/api/requests/{id}', auth: 'required', body: false, ok: [200] },
    { method: 'patch', path: '/api/requests/{id}', auth: 'required', body: true, ok: [200] },
    { method: 'post', path: '/api/reports', auth: 'none', body: true, ok: [200, 201] },
    { method: 'get', path: '/api/admin/backfill-status', auth: 'required', body: false, ok: [200], scope: 'ops:poi' },
    { method: 'post', path: '/api/admin/cache-cleanup', auth: 'required', body: false, ok: [200], scope: 'ops:cache' },
    { method: 'post', path: '/api/admin/maps-lock', auth: 'required', body: true, ok: [200], scope: 'ops:maps' },
    { method: 'get', path: '/api/admin/maps-settings', auth: 'required', body: false, ok: [200], scope: 'ops:maps' },
    { method: 'post', path: '/api/admin/maps-unlock', auth: 'required', body: false, ok: [200], scope: 'ops:maps' },
    { method: 'get', path: '/api/admin/pois-due-refresh', auth: 'required', body: false, ok: [200], scope: 'ops:poi', query: ['limit'] },
    { method: 'get', path: '/api/admin/pois-pending-place-id', auth: 'required', body: false, ok: [200], scope: 'ops:poi', query: ['limit'] },
    { method: 'get', path: '/api/admin/quota-estimate', auth: 'required', body: false, ok: [200], scope: 'ops:maps' },
  ];
  let paths: Record<string, Record<string, Op>>;
  beforeAll(async () => {
    const app = createApp();
    const res = await app.request('/openapi.json', {}, mockEnv(db) as Env);
    paths = ((await res.json()) as { paths: typeof paths }).paths;
  });

  for (const r of routes) {
    it(`${r.method.toUpperCase()} ${r.path}`, () => {
      const op = paths[r.path]?.[r.method];
      expect(op, '路由沒有登記').toBeDefined();
      // 有 schema 的成功回應
      for (const code of r.ok) expect(op!.responses?.[code]?.content?.['application/json']?.schema, `${code} 沒有 schema`).toBeDefined();
      // 至少一個錯誤回應有 ApiError schema（公開的 reports 與其他一樣有 400）
      expect(Object.keys(op!.responses ?? {}).some((c) => Number(c) >= 400), '沒有錯誤回應').toBe(true);
      if (r.body) expect(op!.requestBody, '缺 requestBody').toBeDefined();
      else expect(op!.requestBody).toBeUndefined();
      if (r.auth === 'required') expect(op!.security).toEqual([{ bearerAuth: [] }]);
      else expect(op!.security).toBeUndefined();
      // 401／403 與路由實際行為一致
      if (r.auth === 'required') expect(op!.responses?.[401]).toBeDefined();
      if (r.scope) {
        expect(op!.responses?.[403]).toBeDefined();
        expect(op!.summary).toContain(r.scope); // 文件要說明所需 scope
      }
      for (const q of r.query ?? []) expect(op!.parameters?.some((p) => p.in === 'query' && p.name === q), `缺 query ${q}`).toBe(true);
    });
  }
});
