/**
 * oauth-misc 路由組的契約測試：實際回應必須符合文件（src/schemas/oauth-misc.ts 與 routes/groups/oauth-misc.ts 的 docs）。
 * OAuth wire 端點：302 只驗狀態碼與 Location 的形狀；扁平錯誤用 OauthMisc_OAuthError，其餘用 ApiError。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.mock('../../src/lib/oauth-client/google-id-token', () => ({
  verifyGoogleIdToken: vi.fn(async (idToken: string) => {
    const payloadB64 = idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)));
  }),
}));

import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip, userIdFor } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { hashPassword } from '../../src/lib/password';
import { sha256Base64Url } from '../../src/lib/crypto';
import { createApp } from '../../src/app';
import { ApiError } from '../../src/schemas/common';
import {
  OauthMisc_AuthRequestInfo, OauthMisc_ClientInfo, OauthMisc_JwkSet, OauthMisc_OAuthError,
  OauthMisc_OpenIdConfiguration, OauthMisc_RedirectTo, OauthMisc_RestrictedToken, OauthMisc_UserInfo,
} from '../../src/schemas/oauth-misc';
import { expectContract } from './support';
import type { Env } from '../../src/env';

const P = 'ct-om-';
const CLIENT = `${P}client`; // 第一方 public client
const CONF = `${P}conf`; // confidential client（revoke）
const CB = 'https://web.example/cb';
const WEB = 'https://web.example';
const PKCE = { code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' };
const OWNER = `${P}owner@test.com`;
const SECRET = `${P}api-secret`;
const TRIP = `${P}trip`;
const configured = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', PUBLIC_ORIGIN: 'https://x.com', WEB_ORIGIN: WEB };

let db: D1Database;
let api: Api;
let ownerUserId: string;
const requestIds: number[] = [];

/** 實際觸發過的 (METHOD path, status)，最後用來確認文件列的每個狀態碼都有被打到。 */
const hit = new Set<string>();
const track = (key: string, res: Response) => { hit.add(`${key} ${res.status}`); return res; };

const errBody = async (res: Response, schema: typeof ApiError | typeof OauthMisc_OAuthError = ApiError) => expectContract(schema, await res.json());
const json = async (res: Response) => res.json();

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { TRIPLINE_API_SECRET: SECRET, ...configured } as Partial<Env>) });
  const secretHash = await hashPassword('ct-om-secret');
  await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, app_description, app_logo_url, homepage_url, redirect_uris, allowed_scopes, status, first_party)
    VALUES (?, 'public', 'CT App', 'desc', NULL, 'https://web.example', ?, ?, 'active', 1)`).bind(CLIENT, JSON.stringify([CB]), JSON.stringify(['openid', 'profile', 'email'])).run();
  await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, client_secret_hash, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, 'confidential', ?, 'CT Conf', ?, '["openid"]', 'active')`).bind(CONF, secretHash, JSON.stringify([CB])).run();
  ownerUserId = (await seedTrip(db, { id: TRIP, owner: OWNER })).ownerUserId;
}, 30000);

afterAll(async () => {
  await db.prepare("DELETE FROM oauth_models WHERE json_extract(payload, '$.client_id') LIKE 'ct-om-%' OR id LIKE 'ct-om-%'").run();
  await db.prepare("DELETE FROM oauth_models WHERE json_extract(payload, '$.user_id') = ?").bind(ownerUserId).run();
  await db.prepare("DELETE FROM client_apps WHERE client_id LIKE 'ct-om-%'").run();
  await db.prepare("DELETE FROM auth_audit_log WHERE client_id LIKE 'ct-om-%' OR user_id = ?").bind(ownerUserId).run();
  await db.prepare("DELETE FROM auth_identities WHERE provider_user_id LIKE 'ct-om-%'").run();
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'oauth-revoke:%'").run();
  for (const id of requestIds) await db.prepare('DELETE FROM trip_requests WHERE id = ?').bind(id).run();
  await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_days WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trips WHERE id = ?').bind(TRIP).run();
  await db.prepare("DELETE FROM users WHERE email LIKE 'ct-om-%' OR id LIKE 'ct-om-%'").run();
  await disposeMiniflare();
});
afterEach(() => { vi.restoreAllMocks(); });

const noUserToken = async (name: string) => {
  const t = `${P}svc-${name}-${crypto.randomUUID()}`;
  await new D1Adapter(db, 'AccessToken').upsert(t, { jti: t, client_id: `${P}svc`, user_id: null, scopes: ['ops:maps'], grantId: `g-${t}` }, 300);
  return t;
};

describe('jwks／openid-configuration', () => {
  it('GET jwks：未設金鑰 → keys 空；設金鑰 → 符合 JWK Set', async () => {
    const empty = track('GET jwks', await api.get('/api/oauth/.well-known/jwks.json'));
    expect(empty.status).toBe(200);
    expectContract(OauthMisc_JwkSet, await json(empty));

    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    const key = btoa(String.fromCharCode(...der));
    const res = await createApi({ env: mockEnv(db, { OAUTH_SIGNING_PRIVATE_KEY: key }) }).get('/api/oauth/.well-known/jwks.json');
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(1);
    expectContract(OauthMisc_JwkSet, body);
  });

  it('GET openid-configuration', async () => {
    const res = track('GET discovery', await api.get('/api/oauth/.well-known/openid-configuration'));
    expect(res.status).toBe(200);
    expectContract(OauthMisc_OpenIdConfiguration, await json(res));
  });
});

describe('authorize／authorize requests', () => {
  const authorize = (params: Record<string, string>) => api.get(`/api/oauth/authorize?${new URLSearchParams(params)}`);
  const VALID = { client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid profile', state: 'st-1', ...PKCE };

  it('GET authorize：302 到 web 授權頁，Location 帶 request_id', async () => {
    const res = track('GET authorize', await authorize(VALID));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(`${WEB}/oauth/authorize`);
    expect([...loc.searchParams.keys()]).toEqual(['request_id']);
    expect(loc.searchParams.get('request_id')).toMatch(/\S+/);
  });

  it('GET authorize：可導回 client 的錯誤 → 302 redirect_uri?error=&error_description=&state=', async () => {
    const res = track('GET authorize', await authorize({ ...VALID, scope: 'admin' }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('error_description')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('st-1');
  });

  it('GET authorize：400 扁平 OAuth 錯誤', async () => {
    const res = track('GET authorize', await authorize({ response_type: 'code' }));
    expect(res.status).toBe(400);
    await errBody(res, OauthMisc_OAuthError);
  });

  async function putRequest(): Promise<string> {
    const id = `${P}areq-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AuthRequest').upsert(id, {
      client_id: CLIENT, redirect_uri: CB, scopes: ['openid', 'profile'], state: 'st-2', ...PKCE, prompt: null,
    }, 600);
    return id;
  }
  const BASE = '/api/oauth/authorize/requests';

  it('GET requests/:id → 200；缺 bearer 401；service token 403；不存在 400', async () => {
    const id = await putRequest();
    const ok = track('GET requests', await api.request('GET', `${BASE}/${id}`, { as: `${P}user@test.com` }));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_AuthRequestInfo, await json(ok));

    const r401 = track('GET requests', await api.get(`${BASE}/${id}`));
    expect(r401.status).toBe(401); await errBody(r401);
    const r403 = track('GET requests', await api.request('GET', `${BASE}/${id}`, { bearer: await noUserToken('g') }));
    expect(r403.status).toBe(403); await errBody(r403);
    const r400 = track('GET requests', await api.request('GET', `${BASE}/${P}nope`, { as: `${P}user@test.com` }));
    expect(r400.status).toBe(400); await errBody(r400);
  });

  it.each(['approve', 'deny'] as const)('POST requests/:id/%s → 200 redirect_to；401／403／400', async (verb) => {
    const key = `POST ${verb}`;
    const ok = track(key, await api.request('POST', `${BASE}/${await putRequest()}/${verb}`, { as: `${P}user@test.com` }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { redirect_to: string };
    expectContract(OauthMisc_RedirectTo, body);
    const loc = new URL(body.redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get(verb === 'approve' ? 'code' : 'error')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('st-2');

    const r401 = track(key, await api.request('POST', `${BASE}/${await putRequest()}/${verb}`));
    expect(r401.status).toBe(401); await errBody(r401);
    const r403 = track(key, await api.request('POST', `${BASE}/${await putRequest()}/${verb}`, { bearer: await noUserToken(verb) }));
    expect(r403.status).toBe(403); await errBody(r403);
    const r400 = track(key, await api.request('POST', `${BASE}/${P}nope/${verb}`, { as: `${P}user@test.com` }));
    expect(r400.status).toBe(400); await errBody(r400);
  });
});

describe('client-info', () => {
  it('200／400／404', async () => {
    const ok = track('GET client-info', await api.get(`/api/oauth/client-info?client_id=${CLIENT}`));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_ClientInfo, await json(ok));
    const r400 = track('GET client-info', await api.get('/api/oauth/client-info'));
    expect(r400.status).toBe(400); await errBody(r400);
    const r404 = track('GET client-info', await api.get(`/api/oauth/client-info?client_id=${P}unknown`));
    expect(r404.status).toBe(404); await errBody(r404);
  });
});

describe('downscope／mint-restricted', () => {
  it('POST downscope：200／400／401／403', async () => {
    const K = 'POST downscope';
    const ok = track(K, await api.request('POST', '/api/oauth/downscope', { as: OWNER, json: { trip_id: TRIP } }));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_RestrictedToken, await json(ok));
    const r400 = track(K, await api.request('POST', '/api/oauth/downscope', { as: OWNER, json: {} }));
    expect(r400.status).toBe(400); await errBody(r400);
    const r401 = track(K, await api.request('POST', '/api/oauth/downscope', { json: { trip_id: TRIP } }));
    expect(r401.status).toBe(401); await errBody(r401);
    const r403 = track(K, await api.request('POST', '/api/oauth/downscope', { as: `${P}outsider@test.com`, json: { trip_id: TRIP } }));
    expect(r403.status).toBe(403); await errBody(r403);
  });

  async function seedRequest(status: string, tripId = TRIP): Promise<number> {
    const row = await db.prepare('INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(tripId, 'ct-om', OWNER, status).first<{ id: number }>();
    requestIds.push(row!.id);
    return row!.id;
  }
  const mint = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
    api.request('POST', '/api/oauth/mint-restricted', { json: body, ...(auth ? { headers: { Authorization: auth } } : {}) });

  it('POST mint-restricted：200／400／401／403／404', async () => {
    const K = 'POST mint-restricted';
    await new D1Adapter(db, 'Consent').upsert(`${ownerUserId}:tripline-tp-request`, { user_id: ownerUserId, client_id: 'tripline-tp-request', scopes: ['openid'], grantedAt: 1 }, 300);
    const ok = track(K, await mint({ request_id: await seedRequest('open') }));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_RestrictedToken, await json(ok));

    const r400 = track(K, await mint({}));
    expect(r400.status).toBe(400); await errBody(r400);
    const r401 = track(K, await mint({ request_id: 1 }, null));
    expect(r401.status).toBe(401); await errBody(r401);
    const r403 = track(K, await mint({ request_id: await seedRequest('completed') }));
    expect(r403.status).toBe(403); await errBody(r403);
    const r404 = track(K, await mint({ request_id: 987654321 }));
    expect(r404.status).toBe(404); await errBody(r404);
  });
});

describe('revoke', () => {
  const revoke = (fields: Record<string, string>) => api.fetch(new Request('https://x.com/api/oauth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
  }));

  it('200 空內容／400／401', async () => {
    const K = 'POST revoke';
    const tok = `${P}rev-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(tok, { client_id: CLIENT, user_id: 'u', scopes: ['openid'], grantId: `g-${tok}` }, 300);
    const ok = track(K, await revoke({ token: tok, client_id: CLIENT }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('');
    const r400 = track(K, await revoke({ client_id: CLIENT }));
    expect(r400.status).toBe(400); await errBody(r400, OauthMisc_OAuthError);
    const r401 = track(K, await revoke({ token: 'x', client_id: CONF, client_secret: 'wrong' }));
    expect(r401.status).toBe(401); await errBody(r401, OauthMisc_OAuthError);
  });

  it('429 扁平錯誤並帶 Retry-After（放最後：會用掉這個 IP 的額度，結束後清掉）', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 52 && last?.status !== 429; i++) last = await revoke({ token: 'x', client_id: CLIENT });
    track('POST revoke', last!);
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toBeTruthy();
    await errBody(last!, OauthMisc_OAuthError);
    await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'oauth-revoke:%'").run();
  });
});

describe('logout／userinfo', () => {
  it.each(['GET', 'POST'] as const)('%s logout：204 無內容／401', async (method) => {
    const K = `${method} logout`;
    const ok = track(K, await api.request(method, '/api/oauth/logout', { as: `${P}lo-${method}@test.com` }));
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    const r401 = track(K, await api.request(method, '/api/oauth/logout'));
    expect(r401.status).toBe(401); await errBody(r401);
  });

  it('GET userinfo：200／401', async () => {
    const K = 'GET userinfo';
    const ok = track(K, await api.request('GET', '/api/oauth/userinfo', { as: `${P}ui@test.com` }));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_UserInfo, await json(ok));
    const r401 = track(K, await api.request('GET', '/api/oauth/userinfo'));
    expect(r401.status).toBe(401); await errBody(r401);
    const svc = track(K, await api.request('GET', '/api/oauth/userinfo', { bearer: await noUserToken('ui') }));
    expect(svc.status).toBe(401); await errBody(svc);
  });
});

describe('login/google／callback/google', () => {
  const start = (params: Record<string, string> = {}, env: Record<string, string> = configured) =>
    createApi({ env: mockEnv(db, env as never) }).get(`/api/oauth/login/google?${new URLSearchParams({ client_id: CLIENT, redirect_uri: CB, state: 'cs', ...PKCE, ...params })}`);

  it('GET login/google：302 導向 Google，query 形狀', async () => {
    const res = track('GET login', await start());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect([...loc.searchParams.keys()].sort()).toEqual(['client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'redirect_uri', 'response_type', 'scope', 'state']);
    expect(loc.searchParams.get('redirect_uri')).toBe('https://x.com/api/oauth/callback/google');
  });

  it('GET login/google：可導回 client 的錯誤 302；不可導回 400 扁平；未設定 503 巢狀', async () => {
    const e302 = track('GET login', await start({ scope: 'admin' }));
    expect(e302.status).toBe(302);
    const loc = new URL(e302.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('state')).toBe('cs');

    const r400 = track('GET login', await start({ client_id: `${P}unknown` }));
    expect(r400.status).toBe(400); await errBody(r400, OauthMisc_OAuthError);
    const r400b = track('GET login', await start({ dpop_jkt: 'short' }));
    expect(r400b.status).toBe(400); await errBody(r400b, OauthMisc_OAuthError);

    const r503 = track('GET login', await start({}, {}));
    expect(r503.status).toBe(503); await errBody(r503);
  });

  const VERIFIER = 'v'.repeat(43);
  const NONCE = 'nonce-ct';
  async function putState(name: string): Promise<string> {
    const id = `${P}state-${name}`;
    await new D1Adapter(db, 'GoogleLoginState').upsert(id, {
      provider: 'google', client_id: CLIENT, redirect_uri: CB, scopes: ['openid', 'email'], client_state: 'cs-1',
      code_challenge: await sha256Base64Url(VERIFIER), code_challenge_method: 'S256',
      nonce: NONCE, google_code_verifier: 'gv', first_party: false,
    }, 600);
    return id;
  }
  const idToken = (claims: object) => {
    const enc = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return [enc('{"alg":"RS256"}'), enc(JSON.stringify({ nonce: NONCE, email_verified: true, ...claims })), 'sig'].join('.');
  };
  const googleOk = (claims: object) => vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'a', id_token: idToken(claims), expires_in: 3600, token_type: 'Bearer' })));
  const callback = (state: string, env: Record<string, string> = configured, extra = 'code=gc') =>
    createApi({ env: mockEnv(db, env as never) }).get(`/api/oauth/callback/google?${extra}&state=${state}`);
  const K = 'GET callback';

  it('302 成功：redirect_uri?code=&state=', async () => {
    googleOk({ sub: `${P}sub-new`, email: `${P}new@example.com` });
    const res = track(K, await callback(await putState('ok')));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect([...loc.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(loc.searchParams.get('state')).toBe('cs-1');
  });

  it('302：使用者在 Google 取消 → error=access_denied', async () => {
    const res = track(K, await callback(await putState('deny'), configured, 'error=access_denied'));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('cs-1');
  });

  it('400 state 無效／email 未驗證、401 nonce 不符、403 停用、409 衝突、502 換 token 失敗、503 未設定', async () => {
    const r400 = track(K, await callback(`${P}state-missing`));
    expect(r400.status).toBe(400); await errBody(r400);

    googleOk({ sub: `${P}sub-unv`, email: `${P}unv@example.com`, email_verified: false });
    const r400b = track(K, await callback(await putState('unv')));
    expect(r400b.status).toBe(400); await errBody(r400b);

    googleOk({ sub: `${P}sub-nonce`, email: `${P}nonce@example.com`, nonce: 'other' });
    const r401 = track(K, await callback(await putState('nonce')));
    expect(r401.status).toBe(401); await errBody(r401);

    await db.prepare("INSERT INTO users (id, email, email_verified_at, display_name, status) VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'S', 'suspended')").bind(`${P}susp`, `${P}susp@example.com`).run();
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").bind(`${P}susp`, `${P}sub-susp`).run();
    googleOk({ sub: `${P}sub-susp`, email: `${P}susp@example.com` });
    const r403 = track(K, await callback(await putState('susp')));
    expect(r403.status).toBe(403); await errBody(r403);

    await db.prepare("INSERT INTO users (id, email, email_verified_at, display_name) VALUES (?, ?, NULL, 'C')").bind(`${P}conf-u`, `${P}conflict@example.com`).run();
    googleOk({ sub: `${P}sub-conf`, email: `${P}conflict@example.com` });
    const r409 = track(K, await callback(await putState('conf')));
    expect(r409.status).toBe(409); await errBody(r409);

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('invalid_grant', { status: 400 }));
    const r502 = track(K, await callback(await putState('502')));
    expect(r502.status).toBe(502); await errBody(r502);

    const r503 = track(K, await callback(await putState('503'), {}));
    expect(r503.status).toBe(503); await errBody(r503);
  });
});

describe('OpenAPI 文件與實測一致', () => {
  type Op = { requestBody?: unknown; responses: Record<string, { content?: Record<string, { schema: Record<string, unknown> }> }>; security?: unknown[] };
  const ROUTES: Array<[string, string, 'required' | 'none', boolean]> = [
    ['get', '/api/oauth/.well-known/jwks.json', 'none', false],
    ['get', '/api/oauth/.well-known/openid-configuration', 'none', false],
    ['get', '/api/oauth/authorize', 'none', false],
    ['get', '/api/oauth/authorize/requests/{id}', 'required', false],
    ['post', '/api/oauth/authorize/requests/{id}/approve', 'required', false],
    ['post', '/api/oauth/authorize/requests/{id}/deny', 'required', false],
    ['get', '/api/oauth/client-info', 'none', false],
    ['post', '/api/oauth/downscope', 'required', true],
    ['post', '/api/oauth/mint-restricted', 'none', true],
    ['post', '/api/oauth/revoke', 'none', true],
    ['get', '/api/oauth/logout', 'required', false],
    ['post', '/api/oauth/logout', 'required', false],
    ['get', '/api/oauth/userinfo', 'required', false],
    ['get', '/api/oauth/login/google', 'none', false],
    ['get', '/api/oauth/callback/google', 'none', false],
  ];
  // 預設文件的 schema 是 { nullable: true }（任意內容）；具體的必須有 $ref／type／properties／組合關鍵字
  const isConcrete = (s: Record<string, unknown>) => ['$ref', 'type', 'properties', 'anyOf', 'oneOf', 'allOf'].some((k) => k in s);
  let doc: { paths: Record<string, Record<string, Op>> };
  beforeAll(async () => {
    doc = (await (await createApp().request('/openapi.json', {}, mockEnv(db))).json()) as typeof doc;
  });

  it.each(ROUTES)('%s %s 有明確文件（responses／requestBody／security）', (method, path, auth, hasBody) => {
    const op = doc.paths[path]?.[method];
    expect(op, '路由未登記').toBeDefined();
    const entries = Object.entries(op!.responses);
    // 每個回應：有具體 schema，或明確沒有 JSON（無 content）；預設的「任意內容」（空 schema）不算
    const concrete = entries.filter(([, r]) => !r.content || isConcrete(r.content['application/json']!.schema));
    expect(concrete.length).toBe(entries.length);
    expect(entries.some(([code]) => /^[23]/.test(code))).toBe(true);
    expect(op!.security !== undefined).toBe(auth === 'required');
    expect(op!.requestBody !== undefined).toBe(hasBody);
  });

  it('文件列出的每個狀態碼都有被實際打到（排除未列出的）', () => {
    const missing: string[] = [];
    const keyOf: Record<string, string> = {
      '/api/oauth/.well-known/jwks.json': 'jwks', '/api/oauth/.well-known/openid-configuration': 'discovery',
      '/api/oauth/authorize': 'authorize', '/api/oauth/authorize/requests/{id}': 'requests',
      '/api/oauth/authorize/requests/{id}/approve': 'approve', '/api/oauth/authorize/requests/{id}/deny': 'deny',
      '/api/oauth/client-info': 'client-info', '/api/oauth/downscope': 'downscope', '/api/oauth/mint-restricted': 'mint-restricted',
      '/api/oauth/revoke': 'revoke', '/api/oauth/logout': 'logout', '/api/oauth/userinfo': 'userinfo',
      '/api/oauth/login/google': 'login', '/api/oauth/callback/google': 'callback',
    };
    for (const [method, path] of ROUTES) {
      const base = keyOf[path]!;
      const key = base === 'approve' || base === 'deny' ? `POST ${base}` : `${method.toUpperCase()} ${base}`;
      for (const code of Object.keys(doc.paths[path]![method]!.responses)) {
        if (!hit.has(`${key} ${code}`)) missing.push(`${key} ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
