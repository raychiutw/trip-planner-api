/**
 * GET /api/oauth/callback/google
 *
 * 行為變更：不再發 session cookie，改 302 到 client 註冊的 redirect_uri 並帶我們自己的 authorization code
 * （能在 token endpoint 兌換）。state／nonce／Google PKCE 來自 oauth_models 的 GoogleLoginState（單次使用）。
 * 外部邊界只 stub 兩個：Google 的 token endpoint（fetch）與 id_token 驗章（會去抓 Google 的 live JWKS；
 * 真實驗章由 jwt／google-id-token 的單元測試涵蓋）。這裡驗的是 callback 流程本身。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/oauth-client/google-id-token', () => ({
  verifyGoogleIdToken: vi.fn(async (idToken: string) => {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('JWT must have 3 parts');
    const payloadB64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (payloadB64.length % 4)) % 4;
    return JSON.parse(atob(payloadB64 + '='.repeat(padLen)));
  }),
}));

import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { sha256Base64Url } from '../../src/lib/crypto';
import type { Env } from '../../src/env';

const EXISTING_EMAIL = 'h1-cb-existing@example.com';
const EXISTING_USER_ID = 'h1-cb-existing-user';
const EXISTING_SUB = 'h1-cb-sub-existing';
const NEW_EMAIL = 'h1-cb-new@example.com';
const NEW_SUB = 'h1-cb-sub-new';
const STATE_PREFIX = 'h1-cb-state-';
const WEB = 'h1-cb-web'; // 第一方
const THIRD = 'h1-cb-third';
const CB = 'https://web.example/cb';
const VERIFIER = 'v'.repeat(43);
const NONCE = 'nonce-123';
const JKT = 'j'.repeat(43);

let db: D1Database;

function makeIdToken(payload: object): string {
  const enc = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return [enc('{"alg":"RS256"}'), enc(JSON.stringify(payload)), 'fake-signature'].join('.');
}

const api = (overrides: Partial<Env> = {}) => createApi({ env: mockEnv(db, overrides) });
const configured = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_ORIGIN: 'https://x.com' };

async function putState(name: string, over: Record<string, unknown> = {}, ttl = 600): Promise<string> {
  const id = STATE_PREFIX + name;
  await new D1Adapter(db, 'GoogleLoginState').upsert(id, {
    provider: 'google', client_id: THIRD, redirect_uri: CB, scopes: ['openid', 'email'], client_state: 'cs-1',
    code_challenge: await sha256Base64Url(VERIFIER), code_challenge_method: 'S256',
    nonce: NONCE, google_code_verifier: 'google-verifier', first_party: false, ...over,
  }, ttl);
  return id;
}
const stateExists = async (id: string) =>
  (await db.prepare("SELECT 1 AS x FROM oauth_models WHERE name = 'GoogleLoginState' AND id = ?").bind(id).first()) !== null;

const callback = (state: string, overrides: Partial<Env> = {}, extra = 'code=auth-code') =>
  api(overrides).get(`https://x.com/api/oauth/callback/google?${extra}&state=${state}`);

let fetchSpy: ReturnType<typeof vi.spyOn>;
function googleReturns(body: BodyInit, status = 200) {
  fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { status }));
}
const googleIssues = (claims: object) => googleReturns(JSON.stringify({
  access_token: 'at', id_token: makeIdToken({ nonce: NONCE, email_verified: true, ...claims }), expires_in: 3600, token_type: 'Bearer',
}));

const ourCodes = async () => (await db.prepare("SELECT id, payload FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.client_id') LIKE 'h1-cb-%'")
  .all<{ id: string; payload: string }>()).results;

async function cleanup() {
  await db.prepare("DELETE FROM oauth_models WHERE (name = 'GoogleLoginState' AND id LIKE ?) OR (name IN ('AuthorizationCode','AccessToken','RefreshToken') AND json_extract(payload, '$.client_id') LIKE 'h1-cb-%')").bind(`${STATE_PREFIX}%`).run();
  for (const sub of [EXISTING_SUB, NEW_SUB]) {
    await db.prepare("DELETE FROM auth_identities WHERE provider = 'google' AND provider_user_id = ?").bind(sub).run();
  }
  await db.prepare('DELETE FROM users WHERE email IN (?, ?)').bind(EXISTING_EMAIL, NEW_EMAIL).run();
}
async function seedExisting(status = 'active', verified: string | null = '2026-01-01T00:00:00.000Z') {
  await db.prepare('INSERT INTO users (id, email, email_verified_at, display_name, status) VALUES (?, ?, ?, ?, ?)')
    .bind(EXISTING_USER_ID, EXISTING_EMAIL, verified, 'Existing', status).run();
}

beforeAll(async () => {
  db = await createTestDb();
  for (const [id, fp] of [[WEB, 1], [THIRD, 0]] as const) {
    await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status, first_party)
      VALUES (?, 'public', 'App', ?, ?, 'active', ?)`).bind(id, JSON.stringify([CB]), JSON.stringify(['openid', 'profile', 'email']), fp).run();
  }
});
beforeEach(cleanup);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await cleanup();
  await db.prepare("DELETE FROM client_apps WHERE client_id LIKE 'h1-cb-%'").run();
  await db.prepare("DELETE FROM auth_audit_log WHERE client_id LIKE 'h1-cb-%'").run();
  await disposeMiniflare();
});

describe('GET /api/oauth/callback/google', () => {
  it('沒有 Google 設定 → 503 OAUTH_NOT_CONFIGURED（不是 500），且不消耗 state', async () => {
    const state = await putState('noconf');
    const res = await callback(state, {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(await stateExists(state)).toBe(true);
    const noSecret = await callback(state, { GOOGLE_CLIENT_ID: 'gid' });
    expect(noSecret.status).toBe(503);
  });

  it('缺 state、不存在、已使用、過期 → 同一個 400 OAUTH_INVALID_STATE', async () => {
    const bodies: string[] = [];
    const missing = await api(configured).get('https://x.com/api/oauth/callback/google?code=c');
    const unknown = await callback('h1-cb-state-missing', configured);
    const expired = await callback(await putState('expired', {}, -1), configured);
    googleIssues({ sub: NEW_SUB, email: NEW_EMAIL });
    const used = await putState('used');
    await callback(used, configured);
    const replay = await callback(used, configured);
    for (const res of [missing, unknown, expired, replay]) {
      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).error.code).toBe('OAUTH_INVALID_STATE');
  });

  it('state 錯誤時不會去打 Google', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    await callback('h1-cb-state-missing', configured);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('happy path（既有 identity）：302 到註冊的 redirect_uri，帶我們的 code 與 client 原本的 state；不發 cookie', async () => {
    await seedExisting();
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, last_used_at) VALUES (?, 'google', ?, '2000-01-01T00:00:00.000Z')")
      .bind(EXISTING_USER_ID, EXISTING_SUB).run();
    const state = await putState('existing');
    googleIssues({ sub: EXISTING_SUB, email: EXISTING_EMAIL, name: 'User Name' });

    const res = await callback(state, configured);
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('state')).toBe('cs-1');
    const stored = await new D1Adapter(db, 'AuthorizationCode').find(loc.searchParams.get('code')!);
    expect(stored).toMatchObject({ client_id: THIRD, user_id: EXISTING_USER_ID, redirect_uri: CB, scopes: ['openid', 'email'], code_challenge_method: 'S256' });

    // 對 Google 的 token 請求帶 PKCE verifier 與 PUBLIC_ORIGIN 組的 redirect_uri
    expect(fetchSpy).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.objectContaining({ method: 'POST' }));
    const sent = new URLSearchParams((fetchSpy.mock.calls[0]![1] as { body: URLSearchParams }).body);
    expect(sent.get('redirect_uri')).toBe('https://x.com/api/oauth/callback/google');
    expect(sent.get('code_verifier')).toBe('google-verifier');
    expect(sent.get('code')).toBe('auth-code');

    const identity = await db.prepare("SELECT last_used_at FROM auth_identities WHERE provider = 'google' AND provider_user_id = ?")
      .bind(EXISTING_SUB).first<{ last_used_at: string }>();
    expect(identity?.last_used_at).not.toBe('2000-01-01T00:00:00.000Z');
    expect(await stateExists(state)).toBe(false);
  });

  it('我們發的 code 真的能在 token endpoint 兌換（第三方 client，帶 redirect_uri 與 PKCE verifier）', async () => {
    await seedExisting();
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").bind(EXISTING_USER_ID, EXISTING_SUB).run();
    googleIssues({ sub: EXISTING_SUB, email: EXISTING_EMAIL });
    const loc = new URL((await callback(await putState('exch'), configured)).headers.get('Location')!);
    const code = loc.searchParams.get('code')!;
    fetchSpy.mockRestore();
    const res = await api(configured).request('POST', '/api/oauth/token', {
      form: { grant_type: 'authorization_code', client_id: THIRD, code, redirect_uri: CB, code_verifier: VERIFIER },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string };
    expect(body.access_token).toBeTruthy();
    // 發出的 token 對應這位使用者
    expect((await api(configured).get('/api/oauth/userinfo', { bearer: body.access_token }).then((r) => r.json()) as { id: string }).id).toBe(EXISTING_USER_ID);
  });

  it('第一方 client：code 沿用 login.ts 的形狀（redirect_uri=null、帶 dpop_jkt、60 秒），且不帶 redirect_uri 可兌換', async () => {
    await seedExisting();
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").bind(EXISTING_USER_ID, EXISTING_SUB).run();
    googleIssues({ sub: EXISTING_SUB, email: EXISTING_EMAIL });
    const state = await putState('fp', { client_id: WEB, first_party: true, dpop_jkt: JKT });
    const loc = new URL((await callback(state, configured)).headers.get('Location')!);
    const code = loc.searchParams.get('code')!;
    const found = await new D1Adapter(db, 'AuthorizationCode').findWithExpiry(code);
    expect(found?.payload).toMatchObject({ client_id: WEB, user_id: EXISTING_USER_ID, redirect_uri: null, dpop_jkt: JKT });
    expect(found!.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    // 沒有 DPoP proof 就不能兌換（金鑰綁定）
    fetchSpy.mockRestore();
    const res = await api(configured).request('POST', '/api/oauth/token', { form: { grant_type: 'authorization_code', client_id: WEB, code, code_verifier: VERIFIER } });
    expect(res.status).toBe(400);
  });

  it('happy path（新使用者）：建立 users + identity，發 code；state 重放被拒、不再打 Google', async () => {
    const state = await putState('new');
    googleIssues({ sub: NEW_SUB, email: NEW_EMAIL, name: 'New' });
    const res = await callback(state, configured);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')!).searchParams.has('code')).toBe(true);
    const user = await db.prepare('SELECT id, display_name, email_verified_at FROM users WHERE email = ?')
      .bind(NEW_EMAIL).first<{ id: string; display_name: string; email_verified_at: string | null }>();
    expect(user!.display_name).toBe('New');
    expect(user!.email_verified_at).toBeTruthy();
    const identity = await db.prepare("SELECT user_id FROM auth_identities WHERE provider = 'google' AND provider_user_id = ?").bind(NEW_SUB).first<{ user_id: string }>();
    expect(identity?.user_id).toBe(user!.id);
    fetchSpy.mockClear();
    const replay = await callback(state, configured);
    expect(replay.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ourCodes()).toHaveLength(1);
  });

  it('nonce 不符 → 401 OAUTH_INVALID_ID_TOKEN，不建使用者、不發 code', async () => {
    const state = await putState('badnonce');
    googleIssues({ sub: NEW_SUB, email: NEW_EMAIL, nonce: 'someone-elses-nonce' });
    const res = await callback(state, configured);
    expect(res.status).toBe(401);
    expect(res.headers.get('Location')).toBeNull();
    expect(await db.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(NEW_EMAIL).first()).toBeNull();
    expect(await ourCodes()).toHaveLength(0);
  });

  it('id_token 沒有 nonce → 同樣拒絕', async () => {
    const state = await putState('nononce');
    googleReturns(JSON.stringify({ access_token: 'a', id_token: makeIdToken({ sub: NEW_SUB, email: NEW_EMAIL, email_verified: true }), expires_in: 1, token_type: 'Bearer' }));
    expect((await callback(state, configured)).status).toBe(401);
    expect(await ourCodes()).toHaveLength(0);
  });

  it('新帳號的 Google email 未驗證 → 400 OAUTH_EMAIL_UNVERIFIED，不建使用者', async () => {
    const state = await putState('unverified');
    googleIssues({ sub: NEW_SUB, email: NEW_EMAIL, email_verified: false });
    const res = await callback(state, configured);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OAUTH_EMAIL_UNVERIFIED');
    expect(await db.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(NEW_EMAIL).first()).toBeNull();
    expect(await ourCodes()).toHaveLength(0);
  });

  it('同 email 的既有帳號：已驗證 → 連結 Google identity；未驗證 → 409（防 squat）', async () => {
    await seedExisting();
    googleIssues({ sub: NEW_SUB, email: EXISTING_EMAIL });
    expect((await callback(await putState('link'), configured)).status).toBe(302);
    const linked = await db.prepare("SELECT user_id FROM auth_identities WHERE provider = 'google' AND provider_user_id = ?").bind(NEW_SUB).first<{ user_id: string }>();
    expect(linked?.user_id).toBe(EXISTING_USER_ID);

    await cleanup();
    await seedExisting('active', null);
    googleIssues({ sub: NEW_SUB, email: EXISTING_EMAIL });
    const res = await callback(await putState('squat'), configured);
    expect(res.status).toBe(409);
    expect(await db.prepare("SELECT 1 AS x FROM auth_identities WHERE provider = 'google' AND provider_user_id = ?").bind(NEW_SUB).first()).toBeNull();
  });

  it('停權帳號 → 403，不發 code', async () => {
    await seedExisting('suspended');
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").bind(EXISTING_USER_ID, EXISTING_SUB).run();
    googleIssues({ sub: EXISTING_SUB, email: EXISTING_EMAIL });
    const res = await callback(await putState('suspended'), configured);
    expect(res.status).toBe(403);
    expect(await ourCodes()).toHaveLength(0);
  });

  it('502 OAUTH_TOKEN_EXCHANGE_FAILED when Google rejects code', async () => {
    googleReturns('invalid_grant', 400);
    const res = await callback(await putState('rejected'), configured);
    expect(res.status).toBe(502);
    expect(await ourCodes()).toHaveLength(0);
  });

  it('400 OAUTH_INVALID_ID_TOKEN when id_token missing sub/email', async () => {
    googleIssues({ aud: 'no-sub-no-email' });
    const res = await callback(await putState('bad-claims'), configured);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OAUTH_INVALID_ID_TOKEN');
  });

  it('id_token 驗章失敗 → 401，不發 code', async () => {
    const { verifyGoogleIdToken } = await import('../../src/lib/oauth-client/google-id-token');
    vi.mocked(verifyGoogleIdToken).mockRejectedValueOnce(new Error('bad signature'));
    googleIssues({ sub: NEW_SUB, email: NEW_EMAIL });
    const res = await callback(await putState('badsig'), configured);
    expect(res.status).toBe(401);
    expect(await ourCodes()).toHaveLength(0);
  });

  it('Google 回 error（使用者取消）：state 有效 → 302 回 client 帶 error=access_denied；state 無效 → 400', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const state = await putState('cancel');
    const res = await api(configured).get(`https://x.com/api/oauth/callback/google?error=access_denied&state=${state}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('cs-1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await stateExists(state)).toBe(false);
    const bad = await api(configured).get('https://x.com/api/oauth/callback/google?error=access_denied&state=h1-cb-state-nope');
    expect(bad.status).toBe(400);
  });
});
