/**
 * token endpoint 簽發 OIDC id_token（scope 含 openid 時）。
 * 走 HTTP 邊界；驗簽用「公開的 JWKS 端點」取得公鑰（client 實際的驗證方式），不是直接拿私鑰比對。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
let KEY: string;
let HASH: string;
const PASSWORD = 'correct-horse-battery';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const ORIGIN = 'https://api.example';

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  KEY = Buffer.from((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer).toString('base64');
  HASH = await hashPassword(PASSWORD);
});
beforeEach(() => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '', PUBLIC_ORIGIN: ORIGIN, OAUTH_SIGNING_PRIVATE_KEY: KEY } as Env;
  d1.raw.prepare("INSERT INTO users (id, email, display_name, email_verified_at) VALUES ('u1', 'alice@example.com', 'Alice', datetime('now'))").run();
  d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES ('u1', 'local', 'alice@example.com', ?, 'pbkdf2')").run(HASH);
  d1.raw.prepare("INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status, first_party) VALUES ('svc', ?, 'confidential', 's', '[]', '[\"openid\",\"ops:read\"]', 'active', 0)").run(HASH);
});
afterEach(() => d1.close());

const app = createApp();
const req = (path: string, init: RequestInit, e: Env = env) => app.request(path, init, e);
async function loginCode(scope?: string, e: Env = env): Promise<string> {
  const res = await req('/api/oauth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify({ email: 'alice@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256', ...(scope ? { scope } : {}) }) }, e);
  return ((await res.json()) as { code: string }).code;
}
const tokenReq = (body: Record<string, string>, e: Env = env) => req('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' }, body: new URLSearchParams(body).toString() }, e);
const exchange = (code: string, e: Env = env) => tokenReq({ grant_type: 'authorization_code', client_id: 'tripline-web', code, code_verifier: VERIFIER }, e);

const b64u = (s: string) => Buffer.from(s, 'base64url');
async function verifyWithJwks(jwt: string) {
  const [h, p, s] = jwt.split('.') as [string, string, string];
  const header = JSON.parse(b64u(h).toString()) as { alg: string; kid: string };
  const jwks = (await (await req('/api/oauth/.well-known/jwks.json', {})).json()) as { keys: (JsonWebKey & { kid: string })[] };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  expect(jwk, 'JWKS 要有對應 kid 的公鑰').toBeDefined();
  const pub = await crypto.subtle.importKey('jwk', jwk!, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, b64u(s), new TextEncoder().encode(`${h}.${p}`));
  return { ok, header, claims: JSON.parse(b64u(p).toString()) as Record<string, unknown> };
}

describe('id_token', () => {
  it('scope 含 openid：回 id_token，用 JWKS 的公鑰驗得過；iss／aud／sub／exp 正確', async () => {
    const body = await (await exchange(await loginCode())).json() as { id_token?: string };
    expect(body.id_token).toBeTruthy();
    const { ok, header, claims } = await verifyWithJwks(body.id_token!);
    expect(ok).toBe(true);
    expect(header.alg).toBe('RS256');
    expect(claims).toMatchObject({ iss: `${ORIGIN}/api/oauth`, aud: 'tripline-web', sub: 'u1' });
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect(Math.abs((claims.iat as number) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('依 scope 帶 email／name claims；沒要的 scope 不洩漏', async () => {
    const full = (await verifyWithJwks(((await (await exchange(await loginCode('openid profile email'))).json()) as { id_token: string }).id_token)).claims;
    expect(full).toMatchObject({ email: 'alice@example.com', email_verified: true, name: 'Alice' });
    const minimal = (await verifyWithJwks(((await (await exchange(await loginCode('openid'))).json()) as { id_token: string }).id_token)).claims;
    expect(minimal.email).toBeUndefined();
    expect(minimal.name).toBeUndefined();
  });

  it('被竄改的 id_token 驗不過', async () => {
    const jwt = ((await (await exchange(await loginCode())).json()) as { id_token: string }).id_token;
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(b64u(p).toString()), sub: 'someone-else' })).toString('base64url');
    expect((await verifyWithJwks(`${h}.${forged}.${s}`)).ok).toBe(false);
  });

  it('refresh 輪替也會簽發新的 id_token', async () => {
    const first = await (await exchange(await loginCode())).json() as { refresh_token: string };
    const res = await tokenReq({ grant_type: 'refresh_token', client_id: 'tripline-web', refresh_token: first.refresh_token });
    const body = await res.json() as { id_token?: string };
    expect(res.status).toBe(200);
    expect((await verifyWithJwks(body.id_token!)).ok).toBe(true);
  });

  it('refresh 縮小到不含 openid 的 scope：不簽 id_token', async () => {
    const first = await (await exchange(await loginCode('openid profile'))).json() as { refresh_token: string };
    const body = await (await tokenReq({ grant_type: 'refresh_token', client_id: 'tripline-web', refresh_token: first.refresh_token, scope: 'profile' })).json() as { id_token?: string };
    expect(body.id_token).toBeUndefined();
  });

  it('沒設簽章 key：照常發 access／refresh token，只是沒有 id_token（不是失敗）', async () => {
    const e = { ...env, OAUTH_SIGNING_PRIVATE_KEY: undefined } as Env;
    const res = await exchange(await loginCode(undefined, e), e);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.access_token).toBeTruthy();
    expect(body.id_token).toBeUndefined();
  });

  it('簽章 key 壞掉：不讓整個 token 請求失敗，也不洩漏錯誤細節', async () => {
    const e = { ...env, OAUTH_SIGNING_PRIVATE_KEY: 'not-a-key' } as Env;
    const res = await exchange(await loginCode(undefined, e), e);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).id_token).toBeUndefined();
    expect(text).not.toMatch(/not-a-key|PKCS|importKey/i);
  });

  it('client_credentials 沒有使用者：不簽 id_token', async () => {
    const res = await tokenReq({ grant_type: 'client_credentials', client_id: 'svc', client_secret: PASSWORD, scope: 'openid' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id_token?: string }).id_token).toBeUndefined();
  });
});
