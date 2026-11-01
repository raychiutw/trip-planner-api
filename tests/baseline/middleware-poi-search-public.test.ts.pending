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
import fs from 'node:fs';
import path from 'node:path';
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

  it('bypass 只限 poi-search 本身：相鄰的需認證路徑對照仍回 401（匿名 GET /api/requests）', async () => {
    const res = await api.get('https://test.com/api/requests');
    expect(res.status).toBe(401);
  });

  // 僅 GET 有 bypass：poi-search 沒有 POST handler，經真實路由派送會在進入 middleware 前就回 405，
  // HTTP 邊界觀察不到「POST 不在 bypass」。這條仍用原始碼比對，交給 #1503 處理。
  it('POST 不在 bypass：POST /api/poi-search 仍走 V2 auth path（原始碼比對，待 #1503）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../functions/api/_middleware.ts'), 'utf8');
    const poiSearchIdx = src.indexOf('/api/poi-search');
    const before = src.slice(Math.max(0, poiSearchIdx - 200), poiSearchIdx);
    expect(before).not.toMatch(/method\s*===\s*['"]POST['"][\s\S]{0,150}poi-search/);
  });
});
