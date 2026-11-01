/**
 * _gcp_monitoring.ts — Google Cloud Monitoring API client (Workers-compatible)
 *
 * Ground-truth Maps Platform request count，透過 Cloud Monitoring
 * `timeSeries.list` 抓 `serviceruntime.googleapis.com/api/request_count` 並
 * 依 consumed_api `method` resource label 分組（billable SKU 維度）。
 *（D1 proxy 估算與 host→name 對照表已移除。）
 *
 * Auth flow (service account):
 *   1. Parse `GOOGLE_CLOUD_SA_KEY` env (Google service-account JSON)
 *   2. Sign JWT (RS256) with scope=monitoring.read, aud=oauth2 token endpoint
 *   3. POST jwt-bearer grant → exchange for access_token (1h TTL)
 *   4. Cache access_token in-isolate (50min)
 *   5. GET monitoring.googleapis.com/v3/projects/:id/timeSeries with Bearer
 *
 * 查詢區間為 month-to-date（當月 1 號 → 現在），caller 直接得真實 MTD counts。
 *
 * Failure：env 缺失 / parse fail / GCP 5xx / token expired retry fail → 回 null。
 * caller (quota-estimate.ts) 收到 null 時回 502 MAPS_UPSTREAM_FAILED，不再投射 / 不用假常數
 * （D1 proxy 估算已移除 — 寧可顯示錯誤也不顯示假金額）。
 *
 * Required env（名稱對齊 _types.ts Env 與 prod secret）:
 *   - GOOGLE_CLOUD_SA_KEY: full service-account JSON 字串
 *   - GOOGLE_CLOUD_PROJECT_ID: 目標 GCP project id（含 Maps Platform 計費）
 */
import { signJwt, importPrivateKey } from './jwt';
import type { JwtClaims } from './jwt';

const SCOPE_MONITORING_READ = 'https://www.googleapis.com/auth/monitoring.read';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MONITORING_HOST = 'https://monitoring.googleapis.com';
const TOKEN_TTL_SEC = 3600;
const TOKEN_CACHE_REFRESH_BUFFER_SEC = 600; // refresh if < 10 min remaining

interface ServiceAccountKey {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string; // PKCS8 PEM
  client_email: string;
  token_uri?: string;
}

interface AccessTokenCache {
  token: string;
  expiresAtSec: number;
}

const TOKEN_CACHE = new Map<string, AccessTokenCache>();

interface GcpMonitoringEnv {
  // NOTE: 名稱必須對齊 functions/api/_types.ts Env 與 prod secret
  // (GOOGLE_CLOUD_SA_KEY / GOOGLE_CLOUD_PROJECT_ID)。曾因讀錯名
  // (GCP_SERVICE_ACCOUNT_KEY_JSON) 導致永遠 fallback、金額全是假常數。
  GOOGLE_CLOUD_SA_KEY?: string;
  GOOGLE_CLOUD_PROJECT_ID?: string;
}

/**
 * Parse service account JSON env. Returns null on missing/invalid input —
 * caller returns 502 MAPS_UPSTREAM_FAILED (no fake-data fallback).
 */
function parseServiceAccount(rawJson: string | undefined): ServiceAccountKey | null {
  if (!rawJson || typeof rawJson !== 'string') return null;
  try {
    const parsed = JSON.parse(rawJson) as ServiceAccountKey;
    if (parsed.type !== 'service_account') return null;
    if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('BEGIN')) return null;
    if (typeof parsed.client_email !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Exchange service-account JWT for OAuth2 access_token. Cached in-isolate
 * by client_email + private_key_id to survive across requests in same Worker
 * instance.
 */
async function getAccessToken(account: ServiceAccountKey): Promise<string | null> {
  const cacheKey = `${account.client_email}:${account.private_key_id}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAtSec - nowSec > TOKEN_CACHE_REFRESH_BUFFER_SEC) {
    return cached.token;
  }

  // Build JWT bearer assertion per RFC 7523 §2.1
  const claims: JwtClaims = {
    iss: account.client_email,
    sub: account.client_email,
    aud: account.token_uri ?? TOKEN_ENDPOINT,
    scope: SCOPE_MONITORING_READ,
    iat: nowSec,
    exp: nowSec + TOKEN_TTL_SEC,
  };
  let assertion: string;
  try {
    const privateKey = await importPrivateKey(account.private_key);
    assertion = await signJwt(claims, privateKey, account.private_key_id);
  } catch {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let resp: Response;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) return null;
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : TOKEN_TTL_SEC;
  TOKEN_CACHE.set(cacheKey, {
    token: json.access_token,
    expiresAtSec: nowSec + expiresIn,
  });
  return json.access_token;
}

interface ServiceCount {
  method: string;
  count: number; // month-to-date request count for this consumed_api method
}

interface TimeSeriesPoint {
  value?: { int64Value?: string; doubleValue?: number };
}

interface TimeSeries {
  // consumed_api resource labels — `method` is the billable SKU dimension
  // (e.g. google.maps.places.v1.Places.SearchText). No host→name map needed.
  resource?: { labels?: { service?: string; method?: string } };
  points?: TimeSeriesPoint[];
}

interface TimeSeriesResponse {
  timeSeries?: TimeSeries[];
}

/**
 * Query Cloud Monitoring for month-to-date request counts grouped by the real
 * consumed_api `method` resource label (verified live: e.g.
 * google.maps.places.v1.Places.SearchText). No host→name mapping — caller prices
 * per method. Returns null on any failure → caller returns 502.
 */
export async function fetchMapsQuotaFromCloudMonitoring(
  env: GcpMonitoringEnv,
): Promise<ServiceCount[] | null> {
  const account = parseServiceAccount(env.GOOGLE_CLOUD_SA_KEY);
  if (!account) return null;
  const projectId = env.GOOGLE_CLOUD_PROJECT_ID ?? account.project_id;
  if (!projectId) return null;

  const accessToken = await getAccessToken(account);
  if (!accessToken) return null;

  // Month-to-date window: 當月 1 號 00:00 UTC → 現在。Cloud Monitoring 以
  // 86400s alignment 回多個每日 point，下方 sum 全部 point 即得 MTD 真值
  // （單調遞增，不再用 dailyCost × dayOfMonth 投射）。
  // 註：Google 免費額度實際以帳單時區（US Pacific）月初重置，此處用 UTC 月初，
  // 月界 ±1 天內可能與 Google 帳單月略有偏差；百級用量下影響可忽略。
  const now = new Date();
  const endTime = now.toISOString();
  const startTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Filter: serviceruntime API request_count + Maps Platform services only.
  // `resource.type="consumed_api"` 是 Maps Platform / serviceruntime 標準 resource type。
  const filter =
    'metric.type="serviceruntime.googleapis.com/api/request_count" ' +
    'AND resource.type="consumed_api"';

  const params = new URLSearchParams({
    filter,
    'interval.startTime': startTime,
    'interval.endTime': endTime,
    'aggregation.alignmentPeriod': '86400s',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    view: 'FULL',
  });
  // group by the real consumed_api resource labels (service + method). `method`
  // is the billable SKU dimension (SearchText / GetPlace / Autocomplete share one
  // service but bill differently). groupByFields 是 repeated param。
  params.append('aggregation.groupByFields', 'resource.label."service"');
  params.append('aggregation.groupByFields', 'resource.label."method"');

  const url = `${MONITORING_HOST}/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    // 401 → token expired between cache check and call → invalidate + caller can retry
    if (resp.status === 401) {
      const cacheKey = `${account.client_email}:${account.private_key_id}`;
      TOKEN_CACHE.delete(cacheKey);
    }
    return null;
  }

  const data = (await resp.json()) as TimeSeriesResponse;
  const series = data.timeSeries ?? [];
  const counts = new Map<string, number>();

  for (const ts of series) {
    const method = ts.resource?.labels?.method;
    if (!method) continue; // 無 method label，skip

    let total = 0;
    for (const point of ts.points ?? []) {
      const intVal = point.value?.int64Value;
      const doubleVal = point.value?.doubleValue;
      if (typeof intVal === 'string') total += Number.parseInt(intVal, 10) || 0;
      else if (typeof doubleVal === 'number') total += Math.round(doubleVal);
    }
    counts.set(method, (counts.get(method) ?? 0) + total);
  }

  return Array.from(counts.entries()).map(([method, count]) => ({ method, count }));
}

/** Reset in-isolate token cache — for tests only. */
export function _resetGcpTokenCacheForTest(): void {
  TOKEN_CACHE.clear();
}
