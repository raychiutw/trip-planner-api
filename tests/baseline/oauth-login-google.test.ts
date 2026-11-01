/**
 * GET /api/oauth/login/google —— 行為變更：state／nonce／對 Google 的 PKCE 存在 oauth_models（GoogleLoginState，
 * 10 分鐘），不用 cookie；請求要帶 client 與已註冊的 redirect_uri。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { sha256Base64Url } from '../../src/lib/crypto';

const CLIENT = 'h1-lg-web';
const THIRD = 'h1-lg-third';
const CB = 'https://web.example/cb';
const PKCE = { code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' };
const JKT = 'j'.repeat(43);

let db: D1Database;
beforeAll(async () => {
  db = await createTestDb();
  await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status, first_party)
    VALUES (?, 'public', 'Web', ?, ?, 'active', 1)`).bind(CLIENT, JSON.stringify([CB]), JSON.stringify(['openid', 'profile', 'email'])).run();
  await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status, first_party)
    VALUES (?, 'public', 'Third', ?, ?, 'active', 0)`).bind(THIRD, JSON.stringify([CB]), JSON.stringify(['openid', 'email'])).run();
});
afterAll(async () => {
  await db.prepare("DELETE FROM oauth_models WHERE name = 'GoogleLoginState' AND json_extract(payload, '$.client_id') LIKE 'h1-lg-%'").run();
  await db.prepare("DELETE FROM client_apps WHERE client_id LIKE 'h1-lg-%'").run();
  await disposeMiniflare();
});

const configured = { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_ORIGIN: 'https://trip-planner-dby.pages.dev' };
const api = (over: Record<string, string> = configured) => createApi({ env: mockEnv(db, over as never) });
const start = (params: Record<string, string> = {}, over?: Record<string, string>) =>
  api(over).get(`https://x.com/api/oauth/login/google?${new URLSearchParams({ client_id: CLIENT, redirect_uri: CB, state: 'cs', ...PKCE, ...params })}`);

async function stored(res: Response) {
  const state = new URL(res.headers.get('Location')!).searchParams.get('state')!;
  const row = await db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'GoogleLoginState' AND id = ?").bind(state)
    .first<{ payload: string; expires_at: number }>();
  expect(row).not.toBeNull();
  return { payload: JSON.parse(row!.payload) as Record<string, unknown>, expiresAt: row!.expires_at };
}

describe('GET /api/oauth/login/google', () => {
  it('沒有 GOOGLE_CLIENT_ID → 503 OAUTH_NOT_CONFIGURED（明確的設定錯誤）', async () => {
    const res = await start({}, {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OAUTH_NOT_CONFIGURED');
  });

  it('只有 GOOGLE_CLIENT_ID 沒有 SECRET 也是 503', async () => {
    expect((await start({}, { GOOGLE_CLIENT_ID: 'x' })).status).toBe(503);
  });

  it('302 到 Google：帶 state、nonce、PKCE（S256），redirect_uri 由 PUBLIC_ORIGIN 決定，不用 cookie', async () => {
    const res = await start();
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('client_id')).toBe('test-client-id');
    expect(loc.searchParams.get('response_type')).toBe('code');
    expect(loc.searchParams.get('scope')).toBe('openid profile email');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://trip-planner-dby.pages.dev/api/oauth/callback/google');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('nonce')!.length).toBeGreaterThanOrEqual(43);
    expect(loc.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
  });

  it('state 存在 oauth_models：10 分鐘 TTL、nonce／verifier／驗過的 client 參數；Google 的 challenge = SHA256(verifier)', async () => {
    const before = Date.now();
    const res = await start({ scope: 'openid email' });
    const loc = new URL(res.headers.get('Location')!);
    const { payload, expiresAt } = await stored(res);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    expect(payload).toMatchObject({
      provider: 'google', client_id: CLIENT, redirect_uri: CB, scopes: ['openid', 'email'], client_state: 'cs',
      code_challenge: PKCE.code_challenge, code_challenge_method: 'S256', first_party: true,
    });
    expect(payload.nonce).toBe(loc.searchParams.get('nonce'));
    expect(loc.searchParams.get('code_challenge')).toBe(await sha256Base64Url(payload.google_code_verifier as string));
    expect(JSON.stringify(Object.keys(payload))).not.toContain('dpop_jkt');
  });

  it('第三方 client 不標記 first_party；dpop_jkt 會被保存', async () => {
    const t = await stored(await start({ client_id: THIRD }));
    expect(t.payload.first_party).toBe(false);
    const d = await stored(await start({ dpop_jkt: JKT }));
    expect(d.payload.dpop_jkt).toBe(JKT);
  });

  it('dpop_jkt 格式不對 → 400，不存 state', async () => {
    const res = await start({ dpop_jkt: 'short' });
    expect(res.status).toBe(400);
  });

  it('沒帶 scope：預設 openid profile email 與 client 允許範圍的交集', async () => {
    const { payload } = await stored(await start({ client_id: THIRD }));
    expect(payload.scopes).toEqual(['openid', 'email']);
  });

  it('state 每次都不同', async () => {
    const a = new URL((await start()).headers.get('Location')!).searchParams.get('state');
    const b = new URL((await start()).headers.get('Location')!).searchParams.get('state');
    expect(a).not.toBe(b);
  });

  it('redirect_uri 未註冊 → 400，絕不導向（也不存 state）', async () => {
    const res = await start({ redirect_uri: 'https://evil.example/cb' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('未知 client → 400', async () => {
    expect((await start({ client_id: 'h1-lg-nope' })).status).toBe(400);
  });

  it('缺 PKCE／scope 不允許 → 302 回 client 帶 error（redirect_uri 已驗過）', async () => {
    const noPkce = await start({ code_challenge: '' });
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    const badScope = await start({ scope: 'admin' });
    expect(new URL(badScope.headers.get('Location')!).searchParams.get('error')).toBe('invalid_scope');
  });
});
