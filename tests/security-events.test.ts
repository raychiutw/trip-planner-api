/**
 * T11：四類安全事件（認證失敗、權限拒絕、token 重放、簽章錯誤）寫入稽核；高嚴重度的走既有的 Telegram 通知管道告警。
 * 走 HTTP 邊界；Telegram 的 fetch 一律以 stub 取代（不會真的連線）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';
import { athOf, newKey, proof } from './support/dpop';

let d1: ReturnType<typeof createD1>;
let env: Env;
let HASH: string;
const PASSWORD = 'correct-horse-battery';
const BOT = 'bot-secret-token-123456';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const app = createApp();
let tg: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '-100999' } as Env;
  HASH ??= await hashPassword(PASSWORD);
  d1.raw.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'owner@example.com');
  d1.raw.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u2', 'stranger@example.com');
  d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES ('u1', 'local', 'owner@example.com', ?, 'pbkdf2')").run(HASH);
  d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id, published) VALUES ('t1', 'T', 'u1', 0)").run();
  d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('u1', 't1', 'owner')").run();
  token('tok-stranger', 'u2');
  tg = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', tg);
});
afterEach(() => { d1.close(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

function token(id: string, userId: string, extra: Record<string, unknown> = {}) {
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, ?)")
    .run(id, JSON.stringify({ client_id: 'web', user_id: userId, scopes: ['trips:read', 'trips:write'], grantId: `g-${id}`, ...extra }), Date.now() + 3600_000);
}
const events = (type?: string) => (type ? d1.raw.prepare('SELECT event_type, outcome, user_id, client_id, failure_reason, metadata FROM auth_audit_log WHERE event_type = ? ORDER BY id').all(type) : d1.raw.prepare('SELECT event_type, outcome, user_id, client_id, failure_reason, metadata FROM auth_audit_log ORDER BY id').all()) as { event_type: string; outcome: string; user_id: string | null; client_id: string | null; failure_reason: string | null; metadata: string | null }[];
const auditDump = () => JSON.stringify(d1.raw.prepare('SELECT * FROM auth_audit_log').all());
const alerts = () => tg.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).text as string);
const get = (path: string, headers: Record<string, string> = {}, ip = '1.1.1.1') => app.request(path, { headers: { 'CF-Connecting-IP': ip, ...headers } }, env);
const loginCode = async () => ((await (await app.request('/api/oauth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '3.3.3.3' }, body: JSON.stringify({ email: 'owner@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' }) }, env)).json()) as { code: string }).code;
const tokenReq = (body: Record<string, string>, headers: Record<string, string> = {}) => app.request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2', ...headers }, body: new URLSearchParams(body).toString() }, env);
const exchange = (code: string, headers: Record<string, string> = {}) => tokenReq({ grant_type: 'authorization_code', client_id: 'tripline-web', code, code_verifier: VERIFIER }, headers);

describe('認證失敗', () => {
  it('無效的 bearer → 稽核 auth_failure（reason=invalid_token），稽核資料裡沒有 token 本身', async () => {
    expect((await get('/api/my-trips', { Authorization: 'Bearer leaked-secret-token-xyz' })).status).toBe(401);
    const [e] = events('auth_failure');
    expect(e).toMatchObject({ event_type: 'auth_failure', outcome: 'failure', failure_reason: 'invalid_token' });
    expect(JSON.parse(e!.metadata!)).toMatchObject({ method: 'GET', path: '/api/my-trips' });
    expect(auditDump()).not.toContain('leaked-secret-token-xyz');
  });
  it('格式錯誤的 Authorization（非 Bearer）→ malformed_authorization；沒帶 Authorization 不算攻擊，不寫稽核', async () => {
    await get('/api/my-trips', { Authorization: 'Basic abc' });
    expect(events('auth_failure').map((x) => x.failure_reason)).toEqual(['malformed_authorization']);
    await get('/api/my-trips');
    expect(events('auth_failure')).toHaveLength(1);
  });
  it('只寫稽核、不發告警（嚴重度低）', async () => {
    await get('/api/my-trips', { Authorization: 'Bearer nope' });
    expect(tg).not.toHaveBeenCalled();
  });
  it('寫入量有上限：同一 IP 一分鐘內狂送無效 token，稽核最多 30 筆（不能被當寫入放大器），回應照常 401', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await get('/api/my-trips', { Authorization: `Bearer bad-${i}` }, '9.9.9.9')).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect(events('auth_failure').length).toBeLessThanOrEqual(30);
    expect(events('auth_failure').length).toBeGreaterThanOrEqual(1);
  });
});

describe('權限拒絕', () => {
  it('已登入但無權限 → 稽核 permission_denied（帶 user_id、錯誤碼、方法與路徑；不含 query 與 body）', async () => {
    const res = await app.request('/api/trips/t1?secret=abc', { method: 'PUT', headers: { Authorization: 'Bearer tok-stranger', 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify({ title: 'private-body-text' }) }, env);
    expect(res.status).toBe(403);
    const [e] = events('permission_denied');
    expect(e).toMatchObject({ outcome: 'failure', user_id: 'u2', failure_reason: 'PERM_DENIED' });
    expect(JSON.parse(e!.metadata!)).toEqual({ method: 'PUT', path: '/api/trips/t1' });
    expect(auditDump()).not.toMatch(/secret=abc|private-body-text/);
    expect(tg).not.toHaveBeenCalled();
  });
  it('一般成功與 404 不會寫權限拒絕稽核', async () => {
    token('tok-owner', 'u1');
    await app.request('/api/trips/t1', { method: 'PUT', headers: { Authorization: 'Bearer tok-owner', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'ok' }) }, env);
    await get('/api/trips/nope', { Authorization: 'Bearer tok-owner' });
    expect(events('permission_denied')).toHaveLength(0);
  });
});

describe('token 重放', () => {
  it('authorization code 重放 → 稽核（reason=auth_code_replay）並告警；告警內容不含 code、token、email', async () => {
    const code = await loginCode();
    expect((await exchange(code)).status).toBe(200);
    expect((await exchange(code)).status).toBe(400);
    expect(events().some((e) => e.failure_reason === 'auth_code_replay' && e.outcome === 'failure')).toBe(true);
    const msgs = alerts();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/token_replay/);
    expect(msgs[0]).toContain('tripline-web');
    for (const secret of [code, BOT, 'owner@example.com', PASSWORD, '2.2.2.2']) expect(msgs[0]).not.toContain(secret);
    expect(String(tg.mock.calls[0]![0])).toContain(`/bot${BOT}/sendMessage`);
  });
  it('refresh token 重用 → 稽核（refresh_token_reuse）並告警', async () => {
    const first = await (await exchange(await loginCode())).json() as { refresh_token: string };
    await tokenReq({ grant_type: 'refresh_token', client_id: 'tripline-web', refresh_token: first.refresh_token });
    expect((await tokenReq({ grant_type: 'refresh_token', client_id: 'tripline-web', refresh_token: first.refresh_token })).status).toBe(400);
    expect(events().some((e) => e.failure_reason === 'refresh_token_reuse')).toBe(true);
    expect(alerts().filter((m) => /token_replay/.test(m))).toHaveLength(1);
  });
  it('告警節流：同類事件 10 分鐘內只發一次，之後再發', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 3; i++) { const c = await loginCode(); await exchange(c); await exchange(c); }
    expect(alerts()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const c = await loginCode(); await exchange(c); await exchange(c);
    expect(alerts()).toHaveLength(2);
  });
  it('DPoP proof 的 jti 重放 → token_replay（reason=dpop_jti_replay）並告警', async () => {
    const key = await newKey();
    const p = await proof(key, { jti: 'same-jti' });
    expect((await exchange(await loginCode(), { DPoP: p })).status).toBe(200);
    expect((await exchange(await loginCode(), { DPoP: p })).status).toBe(400);
    expect(events('token_replay').map((e) => e.failure_reason)).toContain('dpop_jti_replay');
    expect(alerts().some((m) => /token_replay/.test(m))).toBe(true);
  });
});

describe('簽章錯誤', () => {
  it('token endpoint 收到簽章／欄位無效的 DPoP proof → 稽核 signature_error（含具體原因）並告警', async () => {
    const key = await newKey();
    const res = await exchange(await loginCode(), { DPoP: await proof(key, { htm: 'GET' }) });
    expect(res.status).toBe(400);
    const [e] = events('signature_error');
    expect(e).toMatchObject({ outcome: 'failure', failure_reason: 'htm', client_id: 'tripline-web' });
    expect(alerts().some((m) => /signature_error/.test(m))).toBe(true);
  });
  it('資源端：綁定的 token 配上別把金鑰的 proof → signature_error；綁定的 token 當 Bearer 用 → auth_failure（dpop_required）', async () => {
    const key = await newKey(); const other = await newKey();
    token('tok-bound', 'u1', { cnf: { jkt: key.jkt } });
    const bad = await proof(other, { htm: 'GET', htu: 'http://localhost/api/my-trips', ath: athOf('tok-bound') });
    expect((await get('/api/my-trips', { Authorization: 'DPoP tok-bound', DPoP: bad })).status).toBe(401);
    expect(events('signature_error').map((e) => e.failure_reason)).toContain('key_mismatch');
    expect((await get('/api/my-trips', { Authorization: 'Bearer tok-bound' })).status).toBe(401);
    expect(events('auth_failure').map((e) => e.failure_reason)).toContain('dpop_required');
  });
});

describe('鎖定', () => {
  it('帳密登入被鎖（IP × 帳號）→ 稽核 rate_limited 並告警', async () => {
    const login = () => app.request('/api/oauth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '5.5.5.5' }, body: JSON.stringify({ email: 'owner@example.com', password: 'wrong', client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' }) }, env);
    for (let i = 0; i < 10; i++) await login();
    expect((await login()).status).toBe(429);
    expect(events('rate_limited').map((e) => e.failure_reason)).toContain('login_locked');
    expect(alerts().some((m) => /rate_limited/.test(m))).toBe(true);
  });
});

describe('告警管道本身', () => {
  it('Telegram 失敗（連線錯誤）不影響原本的回應', async () => {
    tg.mockRejectedValue(new Error('network down'));
    const code = await loginCode(); await exchange(code);
    expect((await exchange(code)).status).toBe(400);
  });
  it('沒設定 TELEGRAM_* → 不發請求、回應照常', async () => {
    const e = { ...env, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined } as Env;
    const code = await loginCode(); await exchange(code);
    await app.request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'tripline-web', code, code_verifier: VERIFIER }).toString() }, e);
    expect(tg).not.toHaveBeenCalled();
  });
  it('console 輸出不含 Telegram bot token（連前綴都不行）', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const code = await loginCode(); await exchange(code); await exchange(code);
    // 物件參數要展開成 JSON 才看得到內容（String(obj) 只會得到 [object Object]）
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(BOT.slice(0, 10));
  });
});
