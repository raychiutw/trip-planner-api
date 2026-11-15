/**
 * oauth-misc 路由組的契約測試：實際回應必須符合文件（src/schemas/oauth-misc.ts 與 routes/groups/oauth-misc.ts 的 docs）。
 * OAuth wire 端點：302 只驗狀態碼與 Location 的形狀；扁平錯誤用 OauthMisc_OAuthError，其餘用 ApiError。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip, userIdFor, seedAiConsent } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { createAuthRequest } from '../../src/lib/auth-request';
import { hashPassword } from '../../src/lib/password';
import { sha256Base64Url } from '../../src/lib/crypto';
import { createApp } from '../../src/app';
import { ApiError } from '../../src/schemas/common';
import {
  OauthMisc_AuthRequestInfo, OauthMisc_AuthRequestIntentBody, OauthMisc_AuthorizeQuery, OauthMisc_ClientInfo, OauthMisc_ClientInfoQuery,
  OauthMisc_DownscopeBody, OauthMisc_MintRestrictedBody, OauthMisc_RevokeBody, OauthMisc_JwkSet, OauthMisc_OAuthError,
  OauthMisc_OpenIdConfiguration, OauthMisc_RedirectTo, OauthMisc_RestrictedToken, OauthMisc_UserInfo,
} from '../../src/schemas/oauth-misc';
import { contractIssues, expectContract } from './support';
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
const configured = { PUBLIC_ORIGIN: 'https://x.com', WEB_ORIGIN: WEB };

let db: D1Database;
let api: Api;
let ownerUserId: string;
const requestIds: number[] = [];

/** 實際觸發過的 (METHOD path, status)，最後用來確認文件列的每個狀態碼都有被打到。 */
const hit = new Set<string>();
const track = (key: string, res: Response) => { hit.add(`${key} ${res.status}`); return res; };

const errBody = async (res: Response, schema: typeof ApiError | typeof OauthMisc_OAuthError = ApiError) => expectContract(schema, await res.json());
/** 測試實際送出的 query／body 必須符合文件 schema；「被 handler 拒絕」的對照則文件 schema 也必須判為不合法。 */
const sent = <T>(schema: Parameters<typeof expectContract>[0], value: T): T => { expectContract(schema, value); return value; };
const docRejects = (schema: Parameters<typeof expectContract>[0], value: unknown) => expect(contractIssues(schema, value)).not.toEqual([]);
const json = async (res: Response) => res.json();
const errCode = async (res: Response) => { const b = await res.json(); expectContract(ApiError, b); return b; };

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { TRIPLINE_API_SECRET: SECRET, ...configured } as Partial<Env>) });
  const secretHash = await hashPassword('ct-om-secret');
  await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, app_description, app_logo_url, homepage_url, redirect_uris, allowed_scopes, status, first_party)
    VALUES (?, 'public', 'CT App', 'desc', NULL, 'https://web.example', ?, ?, 'active', 1)`).bind(CLIENT, JSON.stringify([CB]), JSON.stringify(['openid', 'profile', 'email'])).run();
  await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, client_secret_hash, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, 'confidential', ?, 'CT Conf', ?, '["openid"]', 'active')`).bind(CONF, secretHash, JSON.stringify([CB])).run();
  ownerUserId = (await seedTrip(db, { id: TRIP, owner: OWNER })).ownerUserId;
  await seedAiConsent(db, OWNER);
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
  const authorize = (params: Record<string, string>) => api.get(`/api/oauth/authorize?${new URLSearchParams(sent(OauthMisc_AuthorizeQuery, params))}`);
  const VALID = { client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid profile', state: 'st-1', ...PKCE };

  it('GET authorize：302 到 web 授權頁，Location 帶 request_id', async () => {
    const res = track('GET authorize', await authorize(VALID));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(`${WEB}/oauth/authorize`);
    expect([...loc.searchParams.keys()]).toEqual(['request_id']);
    expect(loc.searchParams.get('request_id')).toMatch(/\S+/);
  });

  it('GET authorize：帶 prompt 也是 302（prompt 欄位型別）', async () => {
    const res = track('GET authorize', await authorize({ ...VALID, prompt: 'consent' }));
    expect(res.status).toBe(302);
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
    await createAuthRequest(db, {
      client_id: CLIENT, redirect_uri: CB, scopes: ['openid', 'profile'], state: 'st-2', ...PKCE, code_challenge_method: 'S256', prompt: null,
    }, { id });
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

  const USER = `${P}user@test.com`;
  /** 重新驗證模式的授權請求：走真實的 authorize 入口建立（prompt=login + biometric_intent + expected_account）。 */
  async function startReauth(expected: string): Promise<string> {
    const q = { ...VALID, prompt: 'login', biometric_intent: 'enable', expected_account: expected };
    const res = track('GET authorize', await authorize(q));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('reauth')).toBe('enable');
    return loc.searchParams.get('request_id')!;
  }
  /** 模擬「剛用密碼登入」：該 grant 的 /api/oauth/login code（redirect_uri 為 null、60 秒 TTL）仍在。 */
  async function freshBearer(email: string): Promise<string> {
    const token = await api.tokenFor(email);
    await new D1Adapter(db, 'AuthorizationCode').upsert(`${P}login-${token}`, {
      client_id: 'http-test', user_id: userIdFor(email), redirect_uri: null, scopes: [], grantId: `grant-${token}`, consumed: Date.now(),
    }, 60);
    return token;
  }

  it('GET authorize：biometric_hint／重新驗證參數 → Location 多 biometric_hint、reauth；expected_account 不合法 → 302 invalid_request', async () => {
    const ok = track('GET authorize', await authorize({ ...VALID, biometric_hint: 'faceid', prompt: 'login', biometric_intent: 'disable', expected_account: userIdFor(USER) }));
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get('Location')!);
    expect([...loc.searchParams.keys()]).toEqual(['request_id', 'biometric_hint', 'reauth']);
    expect(loc.searchParams.get('biometric_hint')).toBe('faceid');
    expect(loc.searchParams.get('reauth')).toBe('disable');

    const bad = track('GET authorize', await authorize({ ...VALID, prompt: 'login', biometric_intent: 'enable', expected_account: 'has space' }));
    expect(bad.status).toBe(302);
    const badLoc = new URL(bad.headers.get('Location')!);
    expect(badLoc.origin + badLoc.pathname).toBe(CB);
    expect(badLoc.searchParams.get('error')).toBe('invalid_request');
    expect(badLoc.searchParams.has('request_id')).toBe(false);
  });

  it('GET authorize：單獨 prompt=login → Location 多 reauth=login；approve 要求剛密碼登入', async () => {
    const res = track('GET authorize', await authorize({ ...VALID, prompt: 'login' }));
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('reauth')).toBe('login');
    const stale = track('POST approve', await api.request('POST', `${BASE}/${loc.searchParams.get('request_id')}/approve`, { bearer: await api.tokenFor(USER) }));
    expect(stale.status).toBe(403);
    expect(await errCode(stale)).toMatchObject({ error: { code: 'OAUTH_REAUTH_REQUIRED' } });
  });

  it('GET requests/:id：from_app／biometric_hint 欄位（faceid／generic／沒帶）', async () => {
    const mk = async (hint?: string) => {
      const loc = new URL((await authorize({ ...VALID, ...(hint ? { biometric_hint: hint } : {}) })).headers.get('Location')!);
      const res = track('GET requests', await api.request('GET', `${BASE}/${loc.searchParams.get('request_id')}`, { as: USER }));
      expect(res.status).toBe(200);
      const body = await json(res);
      expectContract(OauthMisc_AuthRequestInfo, body);
      return body;
    };
    expect(await mk('faceid')).toMatchObject({ from_app: true, biometric_hint: 'faceid' });
    expect(await mk('generic')).toMatchObject({ from_app: true, biometric_hint: null });
    expect(await mk()).toMatchObject({ from_app: false, biometric_hint: null });
  });

  it('POST requests/:id/intent → 204；401／403／400（不存在、值不合法、重新驗證模式）', async () => {
    const K = 'POST intent';
    const call = (id: string, init: Parameters<typeof api.request>[2]) => api.request('POST', `${BASE}/${id}/intent`, init);
    const ok = track(K, await call(await putRequest(), { as: USER, json: sent(OauthMisc_AuthRequestIntentBody, { intent: 'enable' }) }));
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    expect((await call(await putRequest(), { as: USER, json: sent(OauthMisc_AuthRequestIntentBody, { intent: null }) })).status).toBe(204);

    const r401 = track(K, await call(await putRequest(), { json: { intent: 'enable' } }));
    expect(r401.status).toBe(401); await errBody(r401);
    const r403 = track(K, await call(await putRequest(), { bearer: await noUserToken('intent'), json: { intent: 'enable' } }));
    expect(r403.status).toBe(403); await errBody(r403);

    const missing = track(K, await call(`${P}nope`, { as: USER, json: { intent: 'enable' } }));
    expect(missing.status).toBe(400); await errBody(missing);
    docRejects(OauthMisc_AuthRequestIntentBody, { intent: 'delete-all' });
    const badValue = track(K, await call(await putRequest(), { as: USER, json: { intent: 'delete-all' } }));
    expect(badValue.status).toBe(400); await errBody(badValue);
    const reauth = track(K, await call(await startReauth(userIdFor(USER)), { as: USER, json: { intent: 'disable' } }));
    expect(reauth.status).toBe(400); await errBody(reauth);
  });

  it('POST approve（重新驗證模式）：不是剛密碼登入 403 OAUTH_REAUTH_REQUIRED（請求保留）；帳號不符 200 帶 error=reauth_account_mismatch 的 redirect_to（請求消耗）；通過 200 帶 biometric_intent', async () => {
    const approve = (id: string, bearer: string) => api.request('POST', `${BASE}/${id}/approve`, { bearer });
    const id = await startReauth(userIdFor(USER));
    const stale = track('POST approve', await approve(id, await api.tokenFor(USER)));
    expect(stale.status).toBe(403);
    expect(await errCode(stale)).toMatchObject({ error: { code: 'OAUTH_REAUTH_REQUIRED' } });

    const bearer = await freshBearer(USER);
    const ok = track('POST approve', await approve(id, bearer));
    expect(ok.status).toBe(200);
    const okBody = (await json(ok)) as { redirect_to: string };
    expectContract(OauthMisc_RedirectTo, okBody);
    const loc = new URL(okBody.redirect_to);
    expect(loc.searchParams.get('biometric_intent')).toBe('enable');
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(track('POST approve', await approve(id, bearer)).status).toBe(400); // 重放

    const id2 = await startReauth(userIdFor(USER));
    const other = `${P}other@test.com`;
    const mismatch = track('POST approve', await approve(id2, await freshBearer(other)));
    expect(mismatch.status).toBe(200);
    const mmBody = (await json(mismatch)) as { redirect_to: string };
    expectContract(OauthMisc_RedirectTo, mmBody);
    const mmLoc = new URL(mmBody.redirect_to);
    expect(mmLoc.searchParams.get('error')).toBe('reauth_account_mismatch');
    expect(mmLoc.searchParams.get('state')).toBe(VALID.state);
    expect(mmLoc.searchParams.has('code')).toBe(false);
    expect(mmLoc.searchParams.has('biometric_intent')).toBe(false);
    expect(track('POST approve', await approve(id2, await freshBearer(USER))).status).toBe(400); // 已被消耗
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

describe('mobile client 環境閘門的錯誤形狀', () => {
  it('approve／deny：環境不符 → 400 unauthorized_client（OAuth 扁平形狀，符合文件的 union）；authorize 同形狀', async () => {
    for (const verb of ['approve', 'deny']) {
      const id = `${P}mobile-${verb}`;
      await createAuthRequest(db, {
        client_id: 'tripline-mobile', redirect_uri: 'https://trip-planner-dby.pages.dev/mobile/oauth/callback', scopes: ['openid'],
        state: null, code_challenge: PKCE.code_challenge, code_challenge_method: 'S256', prompt: null,
      }, { id });
      const res = track(`POST ${verb}`, await api.request('POST', `/api/oauth/authorize/requests/${id}/${verb}`, { as: `${P}user@test.com` })); // api 沒有 ENVIRONMENT → 沒有 mobile 契約
      expect(res.status).toBe(400);
      const body = await res.json();
      expectContract(OauthMisc_OAuthError, body);
      expect(body).toMatchObject({ error: 'unauthorized_client' });
    }
    const authz = track('GET authorize', await api.get(`/api/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'tripline-mobile', redirect_uri: 'https://trip-planner-dby.pages.dev/mobile/oauth/callback', ...PKCE })}`));
    expect(authz.status).toBe(400);
    const authzBody = await authz.json();
    expectContract(OauthMisc_OAuthError, authzBody);
    expect(authzBody).toMatchObject({ error: 'unauthorized_client' });
  });
});

describe('client-info', () => {
  it('200／400／404', async () => {
    const ok = track('GET client-info', await api.get(`/api/oauth/client-info?client_id=${sent(OauthMisc_ClientInfoQuery, { client_id: CLIENT }).client_id}`));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_ClientInfo, await json(ok));
    docRejects(OauthMisc_ClientInfoQuery, {});
    await db.prepare("UPDATE client_apps SET app_logo_url = 'https://web.example/logo.png' WHERE client_id = ?").bind(CLIENT).run();
    const withLogo = (await (await api.get(`/api/oauth/client-info?client_id=${CLIENT}`)).json()) as Record<string, unknown>;
    expect(withLogo.app_logo_url).toBe('https://web.example/logo.png');
    expectContract(OauthMisc_ClientInfo, withLogo);
    const r400 = track('GET client-info', await api.get('/api/oauth/client-info'));
    expect(r400.status).toBe(400); await errBody(r400);
    const r404 = track('GET client-info', await api.get(`/api/oauth/client-info?${new URLSearchParams(sent(OauthMisc_ClientInfoQuery, { client_id: `${P}unknown` }))}`));
    expect(r404.status).toBe(404); await errBody(r404);
  });
});

describe('downscope／mint-restricted', () => {
  it('POST downscope：200／400／401／403', async () => {
    const K = 'POST downscope';
    const ok = track(K, await api.request('POST', '/api/oauth/downscope', { as: OWNER, json: sent(OauthMisc_DownscopeBody, { trip_id: TRIP }) }));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_RestrictedToken, await json(ok));
    docRejects(OauthMisc_DownscopeBody, {});
    docRejects(OauthMisc_DownscopeBody, { trip_id: 5 });
    const r400 = track(K, await api.request('POST', '/api/oauth/downscope', { as: OWNER, json: {} }));
    expect(r400.status).toBe(400); await errBody(r400);
    const r401 = track(K, await api.request('POST', '/api/oauth/downscope', { json: sent(OauthMisc_DownscopeBody, { trip_id: TRIP }) }));
    expect(r401.status).toBe(401); await errBody(r401);
    const r403 = track(K, await api.request('POST', '/api/oauth/downscope', { as: `${P}outsider@test.com`, json: sent(OauthMisc_DownscopeBody, { trip_id: TRIP }) }));
    expect(r403.status).toBe(403); await errBody(r403);
  });

  async function seedRequest(status: string, tripId = TRIP): Promise<number> {
    const row = await db.prepare('INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(tripId, 'ct-om', OWNER, status).first<{ id: number }>();
    requestIds.push(row!.id);
    return row!.id;
  }
  const mint = (body: Record<string, unknown>, auth: string | null = `Bearer ${SECRET}`) =>
    api.request('POST', '/api/oauth/mint-restricted', { json: Object.keys(body).length ? sent(OauthMisc_MintRestrictedBody, body) : body, ...(auth ? { headers: { Authorization: auth } } : {}) });

  it('POST mint-restricted：200／400／401／403／404', async () => {
    const K = 'POST mint-restricted';
    await new D1Adapter(db, 'Consent').upsert(`${ownerUserId}:tripline-tp-request`, { user_id: ownerUserId, client_id: 'tripline-tp-request', scopes: ['openid'], grantedAt: 1 }, 300);
    const ok = track(K, await mint({ request_id: await seedRequest('open') }));
    expect(ok.status).toBe(200);
    expectContract(OauthMisc_RestrictedToken, await json(ok));

    docRejects(OauthMisc_MintRestrictedBody, {});
    const strMint = await mint({ request_id: String(await seedRequest('open')) });
    expect(strMint.status).toBe(200);
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
  const revokeSent = (fields: Record<string, string>) => revoke(sent(OauthMisc_RevokeBody, fields));

  it('200 空內容／400／401', async () => {
    const K = 'POST revoke';
    const tok = `${P}rev-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(tok, { client_id: CLIENT, user_id: 'u', scopes: ['openid'], grantId: `g-${tok}` }, 300);
    const ok = track(K, await revokeSent({ token: tok, client_id: CLIENT }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('');
    docRejects(OauthMisc_RevokeBody, { client_id: CLIENT });
    const r400 = track(K, await revoke({ client_id: CLIENT }));
    expect(r400.status).toBe(400); await errBody(r400, OauthMisc_OAuthError);
    const r401 = track(K, await revokeSent({ token: 'x', client_id: CONF, client_secret: 'wrong' }));
    expect(r401.status).toBe(401); await errBody(r401, OauthMisc_OAuthError);
  });

  it('429 扁平錯誤並帶 Retry-After（放最後：會用掉這個 IP 的額度，結束後清掉）', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 52 && last?.status !== 429; i++) last = await revokeSent({ token: 'x', client_id: CLIENT });
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
    await db.prepare("UPDATE users SET avatar_url = 'https://web.example/a.png' WHERE id = ?").bind(userIdFor(`${P}ui@test.com`)).run();
    const withAvatar = (await (await api.request('GET', '/api/oauth/userinfo', { as: `${P}ui@test.com` })).json()) as Record<string, unknown>;
    expect(withAvatar.avatarUrl).toBe('https://web.example/a.png');
    expectContract(OauthMisc_UserInfo, withAvatar);
    const r401 = track(K, await api.request('GET', '/api/oauth/userinfo'));
    expect(r401.status).toBe(401); await errBody(r401);
    const svc = track(K, await api.request('GET', '/api/oauth/userinfo', { bearer: await noUserToken('ui') }));
    expect(svc.status).toBe(401); await errBody(svc);
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
    ['post', '/api/oauth/authorize/requests/{id}/intent', 'required', true],
    ['get', '/api/oauth/client-info', 'none', false],
    ['post', '/api/oauth/downscope', 'required', true],
    ['post', '/api/oauth/mint-restricted', 'none', true],
    ['post', '/api/oauth/revoke', 'none', true],
    ['get', '/api/oauth/logout', 'required', false],
    ['post', '/api/oauth/logout', 'required', false],
    ['get', '/api/oauth/userinfo', 'required', false],
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

  it('文件描述涵蓋重新驗證的行為（intent 400、approve 403 只剩 REAUTH_REQUIRED、200 說明帳號不符）', () => {
    const desc = (path: string, code: string) => (doc.paths[path]!.post as unknown as { responses: Record<string, { description: string }> }).responses[code]!.description;
    expect(desc('/api/oauth/authorize/requests/{id}/intent', '400')).toContain('重新驗證');
    expect(desc('/api/oauth/authorize/requests/{id}/approve', '403')).toContain('OAUTH_REAUTH_REQUIRED');
    expect(desc('/api/oauth/authorize/requests/{id}/approve', '403')).not.toContain('OAUTH_REAUTH_ACCOUNT_MISMATCH');
    expect(desc('/api/oauth/authorize/requests/{id}/approve', '200')).toContain('reauth_account_mismatch');
    expect(desc('/api/oauth/authorize/requests/{id}/deny', '403')).not.toContain('REAUTH'); // deny 不受重新驗證限制
  });

  it('文件列出的每個狀態碼都有被實際打到（排除未列出的）', () => {
    const missing: string[] = [];
    const keyOf: Record<string, string> = {
      '/api/oauth/.well-known/jwks.json': 'jwks', '/api/oauth/.well-known/openid-configuration': 'discovery',
      '/api/oauth/authorize': 'authorize', '/api/oauth/authorize/requests/{id}': 'requests',
      '/api/oauth/authorize/requests/{id}/approve': 'approve', '/api/oauth/authorize/requests/{id}/deny': 'deny',
      '/api/oauth/authorize/requests/{id}/intent': 'intent',
      '/api/oauth/client-info': 'client-info', '/api/oauth/downscope': 'downscope', '/api/oauth/mint-restricted': 'mint-restricted',
      '/api/oauth/revoke': 'revoke', '/api/oauth/logout': 'logout', '/api/oauth/userinfo': 'userinfo',
    };
    for (const [method, path] of ROUTES) {
      const base = keyOf[path]!;
      const key = base === 'approve' || base === 'deny' || base === 'intent' ? `POST ${base}` : `${method.toUpperCase()} ${base}`;
      for (const code of Object.keys(doc.paths[path]![method]!.responses)) {
        if (!hit.has(`${key} ${code}`)) missing.push(`${key} ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
