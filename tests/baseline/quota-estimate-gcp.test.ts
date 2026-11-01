/**
 * GET /api/admin/quota-estimate + _gcp_monitoring.ts
 *
 * Root causes locked here (v2.46.x). The daily report's Google Maps 金額 每天忽高忽低:
 *   1. _gcp_monitoring.ts read env.GCP_SERVICE_ACCOUNT_KEY_JSON / GCP_PROJECT_ID, but
 *      prod secret + _types.ts Env use GOOGLE_CLOUD_SA_KEY / GOOGLE_CLOUD_PROJECT_ID.
 *      Name mismatch → always null → fell back to D1-proxy synthetic constants
 *      (directions=50, …) = fake $0.4433 floor.
 *   2. MTD was projected (dailyCost × dayOfMonth) so it swung / decreased day-over-day.
 *   3. The host→name map (GCP_API_TO_SERVICE) collapsed New Places API (all
 *      places.googleapis.com) into place_details. Replaced by grouping on the real
 *      consumed_api `method` resource label; the map is deleted.
 *
 * Fix: correct env names, query real month-to-date counts grouped by method, and —
 * per user direction — throw 502 MAPS_UPSTREAM_FAILED when GCP is unavailable
 * instead of fabricating numbers. The D1-proxy fallback is removed entirely.
 *
 * 走 HTTP 邊界：真實 middleware 與真實 service token（ops:maps）。GCP（OAuth token endpoint 與
 * Cloud Monitoring）是外部邊界，用 stub 攔截 global fetch；服務帳號用測試當下產生的 RSA 金鑰簽 JWT。
 * 原本讀原始碼字串的守門（env 名稱、MTD 視窗、groupBy、已刪的 D1 proxy 常數）改成驗證請求與回應的行為。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';
import { _resetGcpTokenCacheForTest } from '../../src/lib/gcp-monitoring';
import type { Env } from '../../src/env';

let db: D1Database;
let token: string;
let saKeyJson: string;

interface Call { url: string; method: string; headers: Headers; body: string | null }
const calls: Call[] = [];
let monitoring: () => Response = () => new Response('{}', { status: 500 });

function stubGcp() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    if (host !== 'oauth2.googleapis.com' && host !== 'monitoring.googleapis.com') {
      throw new Error(`測試不應對外發請求：${url}`);
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (host === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'gcp-access-token', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return monitoring();
  });
}

const series = (method: string | undefined, values: string[]) => ({
  resource: { labels: { service: 'places.googleapis.com', ...(method ? { method } : {}) } },
  points: values.map((v) => ({ value: { int64Value: v } })),
});
const monitoringOk = (timeSeries: unknown[]) => () =>
  new Response(JSON.stringify({ timeSeries }), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function makeServiceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n');
  const dash = '-----'; // 執行時才組出 PEM 框線（金鑰本身也是即時產生的拋棄式測試金鑰）
  return JSON.stringify({
    type: 'service_account',
    project_id: 'sa-embedded-project',
    private_key_id: 'kid-t5a',
    private_key: [`${dash}BEGIN PRIVATE KEY${dash}`, b64, `${dash}END PRIVATE KEY${dash}`, ''].join('\n'),
    client_email: 't5a-service-account.iam.invalid',
  });
}

function apiWith(overrides: Partial<Env> & Record<string, unknown>): Api {
  return createApi({ env: mockEnv(db, overrides as Partial<Env>) });
}
const configured = () => apiWith({ GOOGLE_CLOUD_SA_KEY: saKeyJson, GOOGLE_CLOUD_PROJECT_ID: 'proj-t5a' });
const getQuota = (client: Api, bearer = token) => client.get('/api/admin/quota-estimate', { bearer });
const monitoringCall = () => calls.find((c) => new URL(c.url).hostname === 'monitoring.googleapis.com');

beforeAll(async () => {
  db = await createTestDb();
  token = await serviceToken(db, ['ops:maps'], 'http-test-t5a-quota');
  saKeyJson = await makeServiceAccountJson();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeMiniflare();
});

beforeEach(() => {
  calls.length = 0;
  monitoring = () => new Response('{}', { status: 500 });
  _resetGcpTokenCacheForTest();
  stubGcp();
});

describe('_gcp_monitoring — env name + grouping (root-cause regression locks)', () => {
  it('reads GOOGLE_CLOUD_SA_KEY / GOOGLE_CLOUD_PROJECT_ID (aligned with _types Env + prod secret)', async () => {
    monitoring = monitoringOk([series('google.maps.places.v1.Places.SearchText', ['1'])]);
    const res = await getQuota(configured());
    expect(res.status).toBe(200);
    // project id 取自 GOOGLE_CLOUD_PROJECT_ID（非 SA JSON 內嵌的 project_id）；token 以 SA 的 client_email 簽發
    const call = monitoringCall()!;
    expect(new URL(call.url).pathname).toBe('/v3/projects/proj-t5a/timeSeries');
    expect(call.headers.get('authorization')).toBe('Bearer gcp-access-token');
    const tokenCall = calls.find((c) => new URL(c.url).hostname === 'oauth2.googleapis.com')!;
    expect(tokenCall.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
  });

  it('does NOT read the phantom GCP_* env names', async () => {
    const res = await getQuota(apiWith({ GCP_SERVICE_ACCOUNT_KEY_JSON: saKeyJson, GCP_PROJECT_ID: 'proj-t5a' }));
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(0); // 沒有任何 GCP 請求 = 幻影名稱完全沒被讀
  });

  it('queries a month-to-date window (month start), not a fixed 24h window', async () => {
    monitoring = monitoringOk([]);
    await getQuota(configured());
    const params = new URL(monitoringCall()!.url).searchParams;
    const start = new Date(params.get('interval.startTime')!);
    const end = new Date(params.get('interval.endTime')!);
    const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    expect(start.getTime()).toBe(monthStart.getTime());
    expect(params.get('aggregation.alignmentPeriod')).toBe('86400s');
  });

  it('groups by the real consumed_api method label, with the host→name map deleted', async () => {
    monitoring = monitoringOk([
      // 同一個 service host（places.googleapis.com）的兩個 method 必須各自獨立，不可被 host→name map 合併
      series('google.maps.places.v1.Places.SearchText', ['100', '284']),
      series('google.maps.places.v1.Places.GetPlace', ['7']),
      // 同 method 的多條 series 要加總
      series('google.maps.places.v1.Places.GetPlace', ['3']),
      // 沒有 method label 的 series 略過
      series(undefined, ['999']),
    ]);
    const res = await getQuota(configured());
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ method: string; count: number }>;
    const byMethod = Object.fromEntries(body.map((s) => [s.method, s.count]));
    expect(byMethod).toEqual({
      'google.maps.places.v1.Places.SearchText': 384,
      'google.maps.places.v1.Places.GetPlace': 10,
    });
    // 查詢本身依 service + method label 分組
    const groupBy = new URL(monitoringCall()!.url).searchParams.getAll('aggregation.groupByFields');
    expect(groupBy).toContain('resource.label."method"');
  });

  it('returns null when no creds are present (caller will surface error)', async () => {
    // 原本直接呼叫 fetchMapsQuotaFromCloudMonitoring({}) 期待 null；HTTP 邊界上 null = 502，且不打 GCP
    const res = await getQuota(apiWith({}));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MAPS_UPSTREAM_FAILED');
    expect(calls).toHaveLength(0);
  });
});

describe('quota-estimate endpoint — GCP-or-error (no synthetic fallback)', () => {
  it('throws MAPS_UPSTREAM_FAILED (502) when GCP unavailable — never fabricates counts', async () => {
    // Cloud Monitoring 回 500 → fetchMapsQuotaFromCloudMonitoring 回 null → middleware 轉 502
    const res = await getQuota(configured());
    expect(monitoringCall()).toBeTruthy();
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MAPS_UPSTREAM_FAILED');
    expect(Array.isArray(body)).toBe(false); // 沒有任何偽造的計數陣列
  });

  it('passes through real per-method counts (no padding, no source field)', async () => {
    monitoring = monitoringOk([
      series('google.maps.places.v1.Places.SearchText', ['384']),
      series('google.maps.routing.v2.Routes.ComputeRoutes', ['4813']),
    ]);
    const res = await getQuota(configured());
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ method: string; count: number; source?: unknown }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2); // passthrough — NOT padded to a fixed 6-service list
    const search = body.find((s) => s.method === 'google.maps.places.v1.Places.SearchText')!;
    expect(search.count).toBe(384);
    expect(search.source).toBeUndefined(); // dead 'source' field dropped
  });

  it('source no longer contains the D1-proxy synthetic constants', async () => {
    // 原本 grep 原始碼無 estimateFromD1Proxy／'d1-proxy'／count: 50|20|10 常數；
    // 行為版：GCP 回空 → 回 []（不補假常數）；GCP 失敗 → 502（不退回 D1 proxy），且回應不含 d1-proxy
    monitoring = monitoringOk([]);
    const empty = await getQuota(configured());
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    monitoring = () => new Response('{}', { status: 503 });
    const failed = await getQuota(configured());
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain('d1-proxy');
  });

  // HTTP 邊界新增：原本 requireScope 被 mock 掉，從沒驗過授權
  it('非 ops:maps 的呼叫者 → 403，且不打 GCP', async () => {
    const other = await serviceToken(db, ['ops:poi'], 'http-test-t5a-quota-other');
    const res = await getQuota(configured(), other);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('未認證 → 401，且不打 GCP', async () => {
    const res = await configured().get('/api/admin/quota-estimate');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
