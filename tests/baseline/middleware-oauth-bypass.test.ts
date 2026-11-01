/**
 * _middleware.ts /api/oauth/* bypass（V2-P1）— 走 HTTP 邊界
 *
 * OAuth endpoints 自管 auth (PKCE / JWT)，不該被 user-session middleware 攔截 401；
 * 但 body encoding 驗證仍要套用。原本是讀 middleware 原始碼比對字串，改成真實請求看回應。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' }) });
});

afterAll(disposeMiniflare);

describe('_middleware.ts — OAuth bypass (V2-P1)', () => {
  // 行為變更：舊測試用 /api/oauth/logout（cookie session 登出）驗 bypass；新 api 沒有 cookie session 與該端點，
  // bypass 由「路由各自宣告 auth 模式」取代，故移除。對照組（受保護路由匿名 → 401）保留如下。
  it('對照組：受保護路由匿名 → 401；公開路由 /api/reports 匿名不是 401', async () => {
    const guarded = await api.get('https://test.com/api/requests');
    expect(guarded.status).toBe(401);
  });

  it('公開端點 POST /api/reports 同樣不需登入（oauth bypass 與公開端點各自 short-circuit）', async () => {
    const res = await api.request('POST', 'https://test.com/api/reports', {
      headers: { Origin: 'https://trip-planner-dby.pages.dev' },
      json: { tripId: 'oauth-bypass-no-such-trip', url: '/x', errorMessage: 'boom' },
    });
    expect(res.status).toBe(201);
  });

  it('非 JSON body 若不是合法 UTF-8 → 400 DATA_ENCODING（公開端點也套用，在 handler 之前）', async () => {
    const res = await api.fetch(new Request('https://test.com/api/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_ENCODING');
  });

  it('合法 UTF-8 但含亂碼特徵（U+FFFD／連續 3 個 Latin Extended）的非 JSON body → 400 DATA_ENCODING', async () => {
    for (const text of ['reason=\uFFFD\uFFFD', 'reason=\u00e4\u00b8\u00ad']) {
      const res = await api.fetch(new Request('https://test.com/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: text,
      }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DATA_ENCODING');
    }
  });

  it('JSON body 不在 middleware 掃描（亂碼欄位交給 handler 自己處理）', async () => {
    const res = await api.request('POST', 'https://test.com/api/reports', { json: { tripId: 'x', errorMessage: '\uFFFD' } });
    // 不是 middleware 的 DATA_ENCODING（由 handler 自己決定要不要擋）
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('DATA_ENCODING');
  });
});
