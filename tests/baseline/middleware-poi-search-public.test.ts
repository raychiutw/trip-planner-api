/**
 * _middleware.ts — GET /api/poi-search public-read bypass (poi-favorites-rename §5.2)
 *
 * Cutover 修補：poi-search 是 Places proxy，無 user data，本應 anonymous public-read
 * （同 /api/route / /api/public-config pattern）。漏列的 198 筆 production 401 由此修補。
 *
 * 走 HTTP 邊界：匿名請求送到 poi-search，若 middleware 放行，會進到 handler 的參數驗證（400），
 * 而不是被擋成 401。原本讀 middleware 原始碼比對字串的斷言，改成看真實回應。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(disposeMiniflare);

describe('_middleware.ts — GET /api/poi-search public-read bypass (§5.2)', () => {
  it('匿名 GET /api/poi-search 被放行：進到 handler 驗證（400），不是 401', async () => {
    const res = await api.get('https://test.com/api/poi-search');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('bypass 先於 session 檢查：帶無效 session cookie 的匿名請求一樣被放行', async () => {
    const res = await api.get('https://test.com/api/poi-search', {
      headers: { Cookie: 'tripline_session=not-a-valid-session' },
    });
    expect(res.status).toBe(400);
  });

  it('bypass 只限 poi-search 本身：相鄰的需認證路徑對照仍回 401（匿名 GET /api/poi-favorites；原測試用 /api/requests，不在本組故改同組路徑）', async () => {
    const res = await api.get('https://test.com/api/poi-favorites');
    expect(res.status).toBe(401);
  });

  // 僅 GET 有 bypass：新 api 的 poi-search 只登記 GET，POST 匿名請求不會拿到 200（改用 HTTP 邊界觀察，取代原本讀舊 middleware 原始碼的比對）。
  it('POST 不在 bypass：匿名 POST /api/poi-search 不會成功（404／405／401）', async () => {
    const res = await api.request('POST', 'https://test.com/api/poi-search', { json: {} });
    expect([401, 404, 405]).toContain(res.status);
  });
});
