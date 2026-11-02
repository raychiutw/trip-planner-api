/**
 * Middleware companion gate — 白名單收窄（2026-11-02，最小權限）
 *
 * `X-Request-Scope: companion` 的請求只能打 agent MCP server 標為 companion 的 10 個工具對應的路徑
 * （見 src/middleware/companion-scope.ts，放行側由 tests/agent-contract/companion-allowlist.test.ts 守）。
 *
 * 本檔守「被移除的 10 項」：帶 companion header（且持有合法的 companion service token）打這些路徑，
 * 一律在 middleware 就回 403 PERM_DENIED「此操作超出旅伴請求範圍」，到不了 handler。
 * 沒帶 companion header 的一般請求完全不受影響（同一批路徑不會被這個 gate 擋）。
 *
 * 舊版這裡驗的是「companion 三 gate（header + OAuth scope + clientId）→ 以 request 提交者身分建立收藏」；
 * 那條路徑現在被白名單擋在 handler 之前，無法由 HTTP 邊界到達，相關測試已刪除（見 PR 說明）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceTokenFor } from './service-token';

const TP_REQUEST_CLIENT_ID = 'tripline-internal-cli';
const ORIGIN = 'https://trip-planner-dby.pages.dev';
const SCOPE_DETAIL = '此操作超出旅伴請求範圍';

let db: D1Database;
let api: Api;
let companionBearer: string;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { TP_REQUEST_CLIENT_ID, ALLOWED_ORIGINS: ORIGIN }) });
  companionBearer = await serviceTokenFor(db, { clientId: TP_REQUEST_CLIENT_ID, scopes: ['companion'] });
});

afterAll(disposeMiniflare);

/** 2026-11-02 自白名單移除的 10 項（method, 代表性 path）。 */
const REMOVED: Array<[string, string]> = [
  ['POST', '/api/trips/t-1/entries/1/trip-pois'],
  ['PATCH', '/api/trips/t-1/trip-pois/5'],
  ['DELETE', '/api/trips/t-1/trip-pois/5'],
  ['PATCH', '/api/requests/42'],
  ['GET', '/api/trips/t-1/days/1'],
  ['GET', '/api/requests?tripId=t-1'],
  ['GET', '/api/poi-favorites'],
  ['POST', '/api/poi-favorites'],
  ['DELETE', '/api/poi-favorites/123'],
  ['POST', '/api/poi-favorites/123/add-to-trip'],
];

async function call(method: string, path: string, companion: boolean): Promise<{ status: number; code?: string; detail?: string }> {
  const res = await api.request(method, `https://test.com${path}`, {
    bearer: companionBearer,
    headers: { ...(companion ? { 'X-Request-Scope': 'companion' } : {}), Origin: ORIGIN },
    json: method === 'GET' ? undefined : {},
  });
  const err = ((await res.json().catch(() => ({}))) as { error?: { code?: string; detail?: string } }).error;
  return { status: res.status, code: err?.code, detail: err?.detail };
}

describe('companion 白名單收窄：被移除的 10 項 → 403 PERM_DENIED', () => {
  it('恰好 10 項', () => expect(REMOVED).toHaveLength(10));

  it.each(REMOVED)('companion header + 合法 companion token：%s %s → 403 PERM_DENIED（超出旅伴請求範圍）', async (method, path) => {
    const r = await call(method, path, true);
    expect(r.status).toBe(403);
    expect(r.code).toBe('PERM_DENIED');
    expect(r.detail).toBe(SCOPE_DETAIL);
  });

  it.each(REMOVED)('對照組：同一路徑沒帶 companion header：%s %s → 不是白名單的 403', async (method, path) => {
    const r = await call(method, path, false);
    expect(r.detail).not.toBe(SCOPE_DETAIL);
  });
});

describe('companion 白名單：保留項仍通過 gate', () => {
  it('companion header：POST /api/trips/t-1/recompute-travel 不被白名單擋（放行側完整清單見 agent-contract）', async () => {
    const r = await call('POST', '/api/trips/t-1/recompute-travel', true);
    expect(r.detail).not.toBe(SCOPE_DETAIL);
  });
});
