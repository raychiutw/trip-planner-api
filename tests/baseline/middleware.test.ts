/**
 * _middleware.ts 行為測試 — 走 HTTP 邊界（tests/api/http.ts）
 *
 * 原本直接呼叫 middleware 匯出的 isAllowedOrigin / checkCsrf / checkCompanionScope / detectSource。
 * 行為變更：isAllowedOrigin / checkCsrf 已移除（新 api 沒有 cookie session、不需 CSRF；Origin 改由全域 cors
 * 白名單處理，測試在 tests/cors.test.ts），對應 describe 在此刪除。
 * 經真實路由派送時 middleware 本來就會跑，所以改成發真實請求、斷言回應與 api_logs 的資料變化：
 *   - isAllowedOrigin / checkCsrf：以 Origin 為唯一變因，看是否被 403（PERM_DENIED）擋下。
 *   - checkCompanionScope：帶 X-Request-Scope: companion，看回應是否為「超出旅伴請求範圍」。
 *   - detectSource：打一個必為 4xx 的請求，看 api_logs.source 欄位。
 *
 * http.ts 的派送先跑 middleware 再找 route，所以沒有對應 route / method handler 的路徑也看得到 middleware 的決定。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';

const BASE = 'https://test.com';
const SCOPE_DETAIL = '此操作超出旅伴請求範圍';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(async () => {
  await db.prepare("DELETE FROM api_logs WHERE path LIKE '/api/trips/mw-src-%'").run();
  await disposeMiniflare();
});

interface ErrBody { error?: { code?: string; detail?: string } }
async function errorOf(res: Response): Promise<ErrBody['error']> {
  return ((await res.json().catch(() => ({}))) as ErrBody).error;
}

describe('checkCompanionScope（X-Request-Scope: companion 的路徑白名單）', () => {
  /** 回傳該請求是否被 companion 白名單擋下（detail 為「超出旅伴請求範圍」）。 */
  async function blocked(method: string, path: string, scope?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (scope) headers['X-Request-Scope'] = scope;
    const res = await api.request(method, `${BASE}${path}`, { headers });
    const err = await errorOf(res);
    const isBlocked = res.status === 403 && err?.detail === SCOPE_DETAIL;
    if (!isBlocked) expect(err?.detail).not.toBe(SCOPE_DETAIL);
    return isBlocked;
  }
  const allowed = async (method: string, path: string) => expect(await blocked(method, path, 'companion')).toBe(false);
  const denied = async (method: string, path: string) => expect(await blocked(method, path, 'companion')).toBe(true);

  it('無 scope header → 放行', async () => {
    expect(await blocked('DELETE', '/api/trips/test-trip')).toBe(false);
  });

  it('companion: PATCH entry → 放行', () => allowed('PATCH', '/api/trips/test-trip/entries/123'));

  it('companion: POST trip-pois → 放行', () => allowed('POST', '/api/trips/test-trip/entries/1/trip-pois'));

  it('companion: PATCH request → 放行', () => allowed('PATCH', '/api/requests/42'));

  it('companion: GET trips → 放行', () => allowed('GET', '/api/trips/test-trip/days/1'));

  it('companion: GET requests → 放行', () => allowed('GET', '/api/requests?tripId=test'));

  it('companion: PATCH pois → 放行', () => allowed('PATCH', '/api/pois/123'));

  // v2.27.0+ entry-POI 主要 endpoints（tp-request containment 補齊；舊清單只有 legacy /trip-pois）
  it('companion: POST alternates → 放行', () => allowed('POST', '/api/trips/test-trip/entries/1/alternates'));

  it('companion: DELETE alternate → 放行', () => allowed('DELETE', '/api/trips/test-trip/entries/1/alternates/9'));

  it('companion: PATCH alternates/reorder → 放行', () => allowed('PATCH', '/api/trips/test-trip/entries/1/alternates/reorder'));

  it('companion: PATCH master → 放行', () => allowed('PATCH', '/api/trips/test-trip/entries/1/master'));

  it('companion: PUT poi-id → 放行', () => allowed('PUT', '/api/trips/test-trip/entries/1/poi-id'));

  it('companion: POST recompute-travel → 放行', () => allowed('POST', '/api/trips/test-trip/recompute-travel'));

  it('companion: POST pois enrich → 放行', () => allowed('POST', '/api/pois/123/enrich'));

  // 白名單外 → 403
  it('companion: DELETE entry（非 alternate）→ 403', () =>
    // 補齊 alternates 白名單後，確認「整個 entry 刪除」仍被擋（❌ 硬限制）
    denied('DELETE', '/api/trips/test-trip/entries/1'));

  it('companion: DELETE trip → 403', () => denied('DELETE', '/api/trips/test-trip'));

  it('companion: POST trips → 403', () => denied('POST', '/api/trips'));

  it('companion: GET permissions → 403', () => denied('GET', '/api/permissions'));

  it('companion: PUT days → 403', () => denied('PUT', '/api/trips/test-trip/days/1'));

  it('companion: PATCH trip-pois → 放行', () => allowed('PATCH', '/api/trips/test-trip/trip-pois/5'));

  it('companion: DELETE trip-pois → 放行', () => allowed('DELETE', '/api/trips/test-trip/trip-pois/5'));

  // 2026-07-28：trip_docs 整條退役（前端不 fetch /docs，checklist/emergency 的 UI
  // 入口 v2.17.17 就移除）。留著這條 companion 放行，agent 想寫行程筆記時就會倒進
  // 這個黑洞 —— prod request 280 正是這樣寫了四次空內容還回報成功。
  // 唯一的消費者是 MCP 的 putDoc 工具，已一併移除。
  it('companion: PUT docs → 擋（trip_docs 已退役，不給 agent 寫）', () =>
    denied('PUT', '/api/trips/test-trip/docs/flights'));
});

describe('detectSource（api_logs.source 的來源分類）', () => {
  let seq = 0;
  /** 對一個必為 4xx 的唯一路徑發請求，回傳 middleware 寫進 api_logs 的 source（沒寫＝null）。 */
  async function loggedSource(headers: Record<string, string>, route = '/api/trips/mw-src-X/days'): Promise<string | null> {
    // query 參數讓每次請求的 path 之外仍可區分；api_logs 只存 pathname，所以用 id 當唯一鍵
    const path = route.replace('X', `${Date.now()}-${seq++}`);
    const res = await api.get(`${BASE}${path}`, { headers });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = await db
      .prepare('SELECT source FROM api_logs WHERE path = ? ORDER BY id DESC LIMIT 1')
      .bind(new URL(path, BASE).pathname)
      .first<{ source: string }>();
    return row?.source ?? null;
  }

  it('scheduler: X-Tripline-Source header → scheduler', async () => {
    expect(await loggedSource({ 'X-Tripline-Source': 'scheduler' })).toBe('scheduler');
  });

  it('scheduler 優先於 companion（同時帶兩個 header）', async () => {
    expect(await loggedSource({ 'X-Tripline-Source': 'scheduler', 'X-Request-Scope': 'companion' })).toBe('scheduler');
  });

  it('companion: X-Request-Scope=companion → companion（路徑在白名單內才會往下走；此處 GET /api/trips/ 在白名單）', async () => {
    expect(await loggedSource({ 'X-Request-Scope': 'companion' })).toBe('companion');
  });

  it('companion 優先於已驗證的 service token', async () => {
    const token = await serviceToken(db, ['companion']);
    expect(await loggedSource({ 'X-Request-Scope': 'companion', Authorization: `Bearer ${token}` })).toBe('companion');
  });

  // 行為變更：舊入口以 CF-Access-Client-* header／CF_Authorization cookie 分類；新 api 沒有這兩者，
  // 改依驗證後的 bearer：service token → service_token、使用者 token → user_jwt。
  it('service_token: 已驗證的 service token → service_token', async () => {
    const token = await serviceToken(db, ['ops:poi']);
    // admin 路由（本組）：ops scope 不符 → 403，是「已驗證身分的 4xx」，會寫 api_logs
    expect(await loggedSource({ Authorization: `Bearer ${token}` }, '/api/admin/maps-settings?x=X')).toBe('service_token');
  });

  it('user_jwt: 已驗證的使用者 token → user_jwt', async () => {
    const token = await api.tokenFor('mw-src-user@test.com');
    expect(await loggedSource({ Authorization: `Bearer ${token}` }, '/api/admin/maps-settings?x=X')).toBe('user_jwt');
  });

  it('偽造的 Authorization（驗證失敗）→ anonymous，401 不寫 log', async () => {
    expect(await loggedSource({ Authorization: 'Bearer forged-token' })).toBeNull();
  });

  it('舊的 CF-Access-Client-* header 不再被承認 → anonymous（4xx 屬 bot 雜訊，不寫 log）', async () => {
    expect(await loggedSource({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' })).toBeNull();
  });

  it('anonymous: 完全沒帶任何 auth → anonymous（4xx 屬 bot 雜訊，不寫 log）', async () => {
    expect(await loggedSource({})).toBeNull();
  });
});
