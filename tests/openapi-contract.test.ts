/**
 * 純 Hono 路由（token／login／sse-ticket／events）的 OpenAPI 文件與實際行為的契約測試（T19 產生 client 的依據）：
 * 文件列出的路徑與 schema 必須存在，且**實際回應能通過文件用的同一份 zod schema**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { LoginRequest, LoginResponse, NestedError, OAuthError, SseTicketResponse, TokenRequest, TokenResponse } from '../src/schemas/oauth';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
let HASH: string;
const PASSWORD = 'correct-horse-battery';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const app = createApp();

beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  HASH ??= await hashPassword(PASSWORD);
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
  d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES ('u1', 'local', 'a@example.com', ?, 'pbkdf2')").run(HASH);
  d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id) VALUES ('t1', 'T', 'u1')").run();
  d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('u1', 't1', 'owner')").run();
  d1.raw.prepare("INSERT INTO trip_requests (id, trip_id, message, status) VALUES (1, 't1', 'hi', 'open')").run();
});
afterEach(() => d1.close());

type Op = { requestBody?: { content: Record<string, unknown> }; responses: Record<string, { content?: Record<string, unknown> }>; parameters?: { name: string; in: string }[]; security?: unknown[] };
async function spec() {
  return (await (await app.request('/openapi.json', {}, env)).json()) as { paths: Record<string, Record<string, Op>>; components?: { securitySchemes?: Record<string, unknown> } };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}, e: Env = env) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', ...headers }, body: JSON.stringify(body) }, e);

describe('文件列出的路徑與方法', () => {
  it('token、login、sse-ticket、events 都在 OpenAPI 裡', async () => {
    const s = await spec();
    expect(s.paths['/api/oauth/token']?.post).toBeDefined();
    expect(s.paths['/api/oauth/login']?.post).toBeDefined();
    expect(s.paths['/api/requests/{id}/sse-ticket']?.post).toBeDefined();
    expect(s.paths['/api/requests/{id}/events']?.get).toBeDefined();
  });
  it('token 同時接受 form 與 JSON；login 只接 JSON；events 回 text/event-stream', async () => {
    const s = await spec();
    expect(Object.keys(s.paths['/api/oauth/token']!.post!.requestBody!.content).sort()).toEqual(['application/json', 'application/x-www-form-urlencoded']);
    expect(Object.keys(s.paths['/api/oauth/login']!.post!.requestBody!.content)).toEqual(['application/json']);
    expect(Object.keys(s.paths['/api/requests/{id}/events']!.get!.responses['200']!.content!)).toEqual(['text/event-stream']);
  });
  it('需要 bearer 的端點標示 security；token／login 是公開的', async () => {
    const s = await spec();
    expect(s.paths['/api/requests/{id}/sse-ticket']!.post!.security).toBeDefined();
    expect(s.paths['/api/oauth/login']!.post!.security ?? []).toEqual([]);
    expect(s.components?.securitySchemes).toBeDefined();
  });
  it('錯誤回應的形狀有寫進文件（OAuth 扁平 vs 巢狀 LOGIN_*）', async () => {
    const s = await spec();
    expect(s.paths['/api/oauth/token']!.post!.responses['400']).toBeDefined();
    expect(s.paths['/api/oauth/login']!.post!.responses['401']).toBeDefined();
    expect(s.paths['/api/oauth/login']!.post!.responses['429']).toBeDefined();
  });
});

describe('實際回應符合文件用的 schema', () => {
  it('login 成功與失敗', async () => {
    const body = { email: 'a@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' };
    expect(LoginRequest.safeParse(body).success).toBe(true);
    const ok = await post('/api/oauth/login', body);
    expect(ok.status).toBe(200);
    expect(LoginResponse.safeParse(await ok.json()).success).toBe(true);
    const bad = await post('/api/oauth/login', { ...body, password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(NestedError.safeParse(await bad.json()).success).toBe(true);
  });

  it('token 成功（含 refresh）與失敗', async () => {
    const code = ((await (await post('/api/oauth/login', { email: 'a@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' })).json()) as { code: string }).code;
    const form = { grant_type: 'authorization_code', client_id: 'tripline-web', code, code_verifier: VERIFIER };
    expect(TokenRequest.safeParse(form).success).toBe(true);
    const res = await app.request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' }, body: new URLSearchParams(form).toString() }, env);
    expect(res.status).toBe(200);
    const parsed = TokenResponse.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    const err = await app.request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' }, body: 'grant_type=password&client_id=x' }, env);
    expect(OAuthError.safeParse(await err.json()).success).toBe(true);
  });

  it('sse-ticket 成功與未登入', async () => {
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', 'tok', ?, ?)").run(JSON.stringify({ client_id: 'web', user_id: 'u1', scopes: ['trips:read'], grantId: 'g' }), Date.now() + 3600_000);
    const ok = await app.request('/api/requests/1/sse-ticket', { method: 'POST', headers: { Authorization: 'Bearer tok' } }, env);
    expect(ok.status).toBe(200);
    expect(SseTicketResponse.safeParse(await ok.json()).success).toBe(true);
    const no = await app.request('/api/requests/1/sse-ticket', { method: 'POST' }, env);
    expect(NestedError.safeParse(await no.json()).success).toBe(true);
  });

  it('schema 不是空殼：缺欄位、型別錯會被擋下', () => {
    expect(LoginRequest.safeParse({ email: 'a@example.com' }).success).toBe(false);
    expect(LoginResponse.safeParse({ code: 1, expires_in: 'x' }).success).toBe(false);
    expect(TokenResponse.safeParse({ access_token: 'a' }).success).toBe(false);
    expect(TokenRequest.safeParse({ grant_type: 'password', client_id: 'x' }).success).toBe(false);
    expect(OAuthError.safeParse({ error: 1 }).success).toBe(false);
    // 邊界：DPoP 綁定的 token_type、client_credentials 沒有 refresh_token、PKCE challenge 與 dpop_jkt 的格式
    const base = { access_token: 'a', expires_in: 3600, scope: 'openid' };
    expect(TokenResponse.safeParse({ ...base, token_type: 'DPoP', refresh_token: 'r' }).success).toBe(true);
    expect(TokenResponse.safeParse({ ...base, token_type: 'Bearer' }).success).toBe(true);
    expect(TokenResponse.safeParse({ ...base, token_type: 'mac' }).success).toBe(false);
    const login = { email: 'a@b.c', password: 'x', client_id: 'c', code_challenge: CHALLENGE, code_challenge_method: 'S256' as const };
    expect(LoginRequest.safeParse({ ...login, code_challenge: 'short' }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...login, code_challenge_method: 'plain' }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...login, dpop_jkt: '!'.repeat(43) }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...login, password: 'p'.repeat(1025) }).success).toBe(false);
  });
});
