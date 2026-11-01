/**
 * GET /api/oauth/authorize —— 第三方授權入口
 * 走 HTTP 邊界。設計變更：沒有 cookie／登入畫面，通過驗證後存一筆 AuthRequest 並 302 到 web 的授權頁。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import type { Env } from '../../src/env';

const CLIENT = 'h1-authz-partner';
const PUBLIC_CLIENT = 'h1-authz-mobile';
const CB = 'https://partner.com/cb';
const WEB = 'https://web.example';

let db: D1Database;
const api = (overrides: Partial<Env> & { WEB_ORIGIN?: string } = { WEB_ORIGIN: WEB } as never) =>
  createApi({ env: mockEnv(db, overrides as Partial<Env>) });

async function seedClient(clientId: string, type: 'confidential' | 'public') {
  await db.prepare(`INSERT OR REPLACE INTO client_apps
    (client_id, client_type, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, ?, 'Partner X', ?, ?, 'active')`)
    .bind(clientId, type, JSON.stringify([CB]), JSON.stringify(['openid', 'profile', 'email'])).run();
}

async function storedRequests(clientId: string) {
  const { results } = await db
    .prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'AuthRequest' AND json_extract(payload, '$.client_id') = ?")
    .bind(clientId).all<{ id: string; payload: string; expires_at: number }>();
  return results.map(r => ({ id: r.id, expiresAt: r.expires_at, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}
const codesCount = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.client_id') LIKE 'h1-authz-%'").first<{ n: number }>())!.n;

const authorize = (params: Record<string, string>, a = api()) =>
  a.get(`https://x.com/api/oauth/authorize?${new URLSearchParams(params)}`);

const PKCE = { code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256' };
const VALID = { client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid profile', state: 'csrf-xyz', ...PKCE };

const CLEAN = "DELETE FROM oauth_models WHERE name IN ('AuthRequest', 'AuthorizationCode') AND json_extract(payload, '$.client_id') LIKE 'h1-authz-%'";

beforeAll(async () => {
  db = await createTestDb();
  await seedClient(CLIENT, 'confidential');
  await seedClient(PUBLIC_CLIENT, 'public');
});
beforeEach(async () => { await db.prepare(CLEAN).run(); });
afterAll(async () => {
  await db.prepare(CLEAN).run();
  await db.prepare("DELETE FROM client_apps WHERE client_id LIKE 'h1-authz-%'").run();
  await disposeMiniflare();
});

describe('GET /api/oauth/authorize', () => {
  it('400 when client_id missing (not redirectable)', async () => {
    const res = await authorize({ response_type: 'code' });
    expect(res.status).toBe(400);
  });

  it('400 when client_id unknown (not redirectable)', async () => {
    const res = await authorize({ client_id: 'h1-authz-unknown', redirect_uri: CB, response_type: 'code', scope: 'openid' });
    expect(res.status).toBe(400);
  });

  it('302 to client redirect_uri with error when scope invalid', async () => {
    const res = await authorize({ client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'admin', state: 'csrf-1' });
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    expect(loc).toContain('https://partner.com/cb?');
    expect(loc).toContain('error=invalid_scope');
    expect(loc).toContain('state=csrf-1');
    expect(await storedRequests(CLIENT)).toHaveLength(0);
  });

  it('缺 PKCE → 302 回 client 帶 invalid_request，不存 AuthRequest', async () => {
    const res = await authorize({ client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid', state: 's' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(await storedRequests(CLIENT)).toHaveLength(0);
  });

  it('Rejects redirect_uri not in whitelist (400，絕不導向攻擊者網址)', async () => {
    const res = await authorize({ client_id: CLIENT, redirect_uri: 'https://evil.com/cb', response_type: 'code', scope: 'openid', ...PKCE });
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
    expect(await storedRequests(CLIENT)).toHaveLength(0);
  });

  it('redirect_uri 只差一個字元也不放行（精確比對）', async () => {
    const res = await authorize({ ...VALID, redirect_uri: `${CB}/` });
    expect(res.status).toBe(400);
    expect(await storedRequests(CLIENT)).toHaveLength(0);
  });

  it('valid → 存 AuthRequest（驗過的參數、約 10 分鐘 TTL）並 302 到 WEB_ORIGIN/oauth/authorize?request_id=', async () => {
    const before = Date.now();
    const res = await authorize(VALID);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(`${WEB}/oauth/authorize`);
    const id = loc.searchParams.get('request_id')!;
    expect(id.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect([...loc.searchParams.keys()]).toEqual(['request_id']); // 網址不帶 redirect_uri 等參數

    const rows = await storedRequests(CLIENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.payload).toMatchObject({
      client_id: CLIENT, redirect_uri: CB, scopes: ['openid', 'profile'], state: 'csrf-xyz',
      code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256',
    });
    expect(rows[0]!.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(rows[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    expect(await codesCount()).toBe(0); // 還沒同意，不發 code
  });

  it('每次請求的 request_id 都不同', async () => {
    const a = new URL((await authorize(VALID)).headers.get('Location')!).searchParams.get('request_id');
    const b = new URL((await authorize(VALID)).headers.get('Location')!).searchParams.get('request_id');
    expect(a).not.toBe(b);
  });

  it('public client 的 PKCE challenge 存進 AuthRequest', async () => {
    const res = await authorize({ client_id: PUBLIC_CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid', code_challenge: 'pkce-challenge-abc', code_challenge_method: 'S256', state: 's' });
    expect(res.status).toBe(302);
    const rows = await storedRequests(PUBLIC_CLIENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.code_challenge).toBe('pkce-challenge-abc');
  });

  it('WEB_ORIGIN 未設時退回 PUBLIC_ORIGIN', async () => {
    const res = await authorize(VALID, api({ PUBLIC_ORIGIN: 'https://public.example' }));
    expect(new URL(res.headers.get('Location')!).origin).toBe('https://public.example');
  });

  it('WEB_ORIGIN 優先於 PUBLIC_ORIGIN', async () => {
    const res = await authorize(VALID, api({ PUBLIC_ORIGIN: 'https://public.example', WEB_ORIGIN: WEB } as never));
    expect(new URL(res.headers.get('Location')!).origin).toBe(WEB);
  });

  it('兩者都沒設 → 400，且不存 AuthRequest', async () => {
    const res = await authorize(VALID, api({}));
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
    expect(await storedRequests(CLIENT)).toHaveLength(0);
  });

  it('過期的 AuthRequest 讀不到', async () => {
    const res = await authorize(VALID);
    const id = new URL(res.headers.get('Location')!).searchParams.get('request_id')!;
    await db.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'AuthRequest' AND id = ?").bind(Date.now() - 1, id).run();
    expect(await new D1Adapter(db, 'AuthRequest').find(id)).toBeUndefined();
  });
});
