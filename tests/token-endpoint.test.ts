/**
 * POST /api/oauth/token（拆分 T9）：authorization_code(+PKCE)、refresh_token 輪替與 family revoke、client_credentials。
 * 走 HTTP 邊界（app.request），真 SQLite（套用全部 migrations）。OAuth wire 錯誤用扁平形狀 {error, error_description}。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
let SECRET_HASH: string;
beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  SECRET_HASH ??= await hashPassword('s3cret-value');
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
  addClient('web', 'public');
  addClient('svc', 'confidential', ['ops:read', 'ops:write']);
  addClient('other', 'public');
});
afterEach(() => d1.close());

function addClient(id: string, type: 'public' | 'confidential', scopes = ['openid', 'profile'], status = 'active') {
  d1.raw.prepare(`INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, ?, ?, ?, '["https://app.example/cb"]', ?, ?)`).run(id, type === 'confidential' ? SECRET_HASH : null, type, id, JSON.stringify(scopes), status);
}
const b64url = (b: Buffer) => b.toString('base64url');
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());
const NOW = Date.now();

function seedCode(code: string, over: Record<string, unknown> = {}, expiresAt = NOW + 60_000) {
  const payload = { client_id: 'web', user_id: 'u1', redirect_uri: 'https://app.example/cb', scopes: ['openid', 'profile'], code_challenge: CHALLENGE, code_challenge_method: 'S256', ...over };
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AuthorizationCode', ?, ?, ?)").run(code, JSON.stringify(payload), expiresAt);
}
function rows(name: string) {
  return d1.raw.prepare('SELECT id, payload FROM oauth_models WHERE name = ?').all(name) as { id: string; payload: string }[];
}
type J = Record<string, unknown>;
function post(body: Record<string, string>, opts: { headers?: Record<string, string>; json?: boolean; ip?: string } = {}) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? '1.1.1.1', ...(opts.headers ?? {}) };
  let payload: string;
  if (opts.json) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  else { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  return createApp().request('/api/oauth/token', { method: 'POST', headers, body: payload }, env);
}
const codeBody = (over: Record<string, string> = {}) => ({ grant_type: 'authorization_code', client_id: 'web', code: 'c1', redirect_uri: 'https://app.example/cb', code_verifier: VERIFIER, ...over });
async function err(res: Response) { return (await res.json()) as { error: string; error_description: string }; }

describe('通用請求檢查', () => {
  it('不支援的 grant_type（含 password）→ 400 unsupported_grant_type，扁平形狀', async () => {
    for (const g of ['password', 'implicit', '']) {
      const res = await post({ grant_type: g, client_id: 'web' });
      expect(res.status, g).toBe(400);
      expect((await err(res)).error).toBe('unsupported_grant_type');
    }
  });
  it('沒有 client_id → invalid_client', async () => {
    const res = await post({ grant_type: 'authorization_code' });
    expect((await err(res)).error).toBe('invalid_client');
  });
  it('未知或停用的 client → 401 invalid_client，且不寫 rate limit（不能被當寫入放大器）', async () => {
    addClient('off', 'public', ['openid'], 'suspended');
    expect((await post(codeBody({ client_id: 'off' }))).status).toBe(401);
    expect((await post(codeBody({ client_id: 'ghost' }))).status).toBe(401);
    const count = (like: string) => (d1.raw.prepare('SELECT count(*) AS n FROM rate_limit_buckets WHERE bucket_key LIKE ?').get(like) as { n: number }).n;
    expect(count('oauth-token:ghost%')).toBe(0);
    expect(count('oauth-token:off%')).toBe(0);
    // 對照：已知 client 會計配額（否則上面的 0 可能只是欄位或前綴寫錯）
    await post(codeBody({ code: 'nope' }));
    expect(count('oauth-token:web')).toBe(1);
  });
  it('JSON 與 form 兩種 body 都收；JSON 壞掉 → 400 invalid_request（不是 500）', async () => {
    seedCode('c1');
    expect((await post(codeBody(), { json: true })).status).toBe(200);
    const bad = await createApp().request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }, env);
    expect(bad.status).toBe(400);
    expect((await err(bad)).error).toBe('invalid_request');
  });
  it('body 過大（>16KB）→ 400 invalid_request，不處理', async () => {
    const res = await post(codeBody({ code: 'x'.repeat(17 * 1024) }));
    expect(res.status).toBe(400);
    expect((await err(res)).error).toBe('invalid_request');
  });
  it('成功與錯誤回應都帶 no-store／no-cache', async () => {
    seedCode('c1');
    const ok = await post(codeBody());
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('pragma')).toBe('no-cache');
    const bad = await post(codeBody({ code: 'nope' }));
    expect(bad.headers.get('cache-control')).toBe('no-store');
  });
});

describe('confidential client 驗證', () => {
  const cc = (over: Record<string, string> = {}) => ({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's3cret-value', ...over });
  it('缺 secret、錯 secret → 401 invalid_client', async () => {
    expect((await post(cc({ client_secret: '' }))).status).toBe(401);
    expect((await post(cc({ client_secret: 'wrong' }))).status).toBe(401);
    expect(rows('AccessToken')).toHaveLength(0);
  });
  it('HTTP Basic 也可（RFC 6749 §2.3.1）', async () => {
    const basic = Buffer.from('svc:s3cret-value').toString('base64');
    const res = await post({ grant_type: 'client_credentials' }, { headers: { Authorization: `Basic ${basic}` } });
    expect(res.status).toBe(200);
  });
  it('錯誤訊息不洩漏 secret 驗證細節以外的資訊（不回 hash）', async () => {
    const text = await (await post(cc({ client_secret: 'wrong' }))).text();
    expect(text).not.toMatch(/pbkdf2|\$/);
  });
});

describe('client_credentials', () => {
  const cc = (over: Record<string, string> = {}) => ({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's3cret-value', ...over });
  it('發 access token（user_id null、scope 預設為 client 全部允許），不發 refresh token', async () => {
    const res = await post(cc());
    expect(res.status).toBe(200);
    const body = await res.json() as J;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'ops:read ops:write' });
    expect(body.refresh_token).toBeUndefined();
    expect(typeof body.access_token).toBe('string');
    expect((body.access_token as string).length).toBeGreaterThanOrEqual(60);
    const [row] = rows('AccessToken');
    expect(JSON.parse(row!.payload)).toMatchObject({ client_id: 'svc', user_id: null, scopes: ['ops:read', 'ops:write'] });
  });
  it('可要求較小的 scope；超出 client 允許的 → invalid_scope', async () => {
    expect(((await (await post(cc({ scope: 'ops:read' }))).json()) as J).scope).toBe('ops:read');
    const res = await post(cc({ scope: 'ops:read admin:all' }));
    expect(res.status).toBe(400);
    expect((await err(res)).error).toBe('invalid_scope');
  });
  it('public client 不可用 client_credentials → 401 unauthorized_client', async () => {
    const res = await post({ grant_type: 'client_credentials', client_id: 'web' });
    expect(res.status).toBe(401);
    expect((await err(res)).error).toBe('unauthorized_client');
  });
  it('allowed_scopes 壞掉 → 視為空白名單（拒絕），不是 500', async () => {
    d1.raw.prepare("UPDATE client_apps SET allowed_scopes = 'not json' WHERE client_id = 'svc'").run();
    const res = await post(cc({ scope: 'ops:read' }));
    expect(res.status).toBe(400);
  });
  it('發出的 token 能通過 bearer 認證（端到端）', async () => {
    const { access_token } = await (await post(cc())).json() as { access_token: string };
    const app = createApp();
    const { bearerAuth, requireAuth } = await import('../src/auth');
    app.use('/x', bearerAuth, requireAuth);
    app.get('/x', (c) => c.json(c.get('auth')));
    const res = await app.request('/x', { headers: { Authorization: `Bearer ${access_token}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isServiceToken: true, clientId: 'svc' });
  });
});

describe('authorization_code + PKCE', () => {
  it('成功：發 access + refresh，scope 與 consent 一致，code 標記已用', async () => {
    seedCode('c1');
    const res = await post(codeBody());
    expect(res.status).toBe(200);
    const body = await res.json() as J;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'openid profile' });
    expect(body.access_token).not.toBe(body.refresh_token);
    expect(JSON.parse(rows('AccessToken')[0]!.payload)).toMatchObject({ client_id: 'web', user_id: 'u1', scopes: ['openid', 'profile'] });
    expect(JSON.parse(rows('AuthorizationCode')[0]!.payload).consumed).toBeTruthy();
  });
  it('缺 code、不存在、過期 → invalid_grant / invalid_request', async () => {
    expect((await err(await post(codeBody({ code: '' })))).error).toBe('invalid_request');
    expect((await err(await post(codeBody({ code: 'nope' })))).error).toBe('invalid_grant');
    seedCode('old', {}, NOW - 1000);
    expect((await err(await post(codeBody({ code: 'old' })))).error).toBe('invalid_grant');
  });
  it('PKCE：缺 verifier、錯 verifier → invalid_grant，且 code 不被消耗', async () => {
    seedCode('c1');
    expect((await err(await post(codeBody({ code_verifier: '' })))).error).toBe('invalid_grant');
    expect((await err(await post(codeBody({ code_verifier: 'x'.repeat(64) })))).error).toBe('invalid_grant');
    expect(JSON.parse(rows('AuthorizationCode')[0]!.payload).consumed).toBeUndefined();
    expect(rows('AccessToken')).toHaveLength(0);
  });
  it('public client 的 code 沒有 code_challenge → 拒絕（強制 PKCE，OAuth 2.1）', async () => {
    seedCode('c1', { code_challenge: null, code_challenge_method: null });
    const res = await post(codeBody({ code_verifier: '' }));
    expect(res.status).toBe(400);
    expect((await err(res)).error).toBe('invalid_grant');
    expect(rows('AccessToken')).toHaveLength(0);
  });
  it('redirect_uri 不符 → invalid_grant', async () => {
    seedCode('c1');
    expect((await err(await post(codeBody({ redirect_uri: 'https://evil.example/cb' })))).error).toBe('invalid_grant');
  });
  it('別的 client 拿這個 code：拒絕，且不會連坐撤銷受害者的 token family', async () => {
    seedCode('c1');
    const first = await post(codeBody());
    expect(first.status).toBe(200);
    const res = await post(codeBody({ client_id: 'other' }));
    expect(res.status).toBe(400);
    expect(rows('AccessToken')).toHaveLength(1);
    expect(rows('RefreshToken')).toHaveLength(1);
  });
  it('不可放寬 scope', async () => {
    seedCode('c1');
    const res = await post(codeBody({ scope: 'openid profile email' }));
    expect((await err(res)).error).toBe('invalid_scope');
  });
  it('重放同一個 code → invalid_grant，並撤銷這個 grant 發出的所有 token', async () => {
    seedCode('c1');
    expect((await post(codeBody())).status).toBe(200);
    expect(rows('AccessToken')).toHaveLength(1);
    const replay = await post(codeBody());
    expect(replay.status).toBe(400);
    expect((await err(replay)).error).toBe('invalid_grant');
    expect(rows('AccessToken')).toHaveLength(0);
    expect(rows('RefreshToken')).toHaveLength(0);
  });
  it('寫入 audit：成功與重放各一筆', async () => {
    seedCode('c1');
    await post(codeBody()); await post(codeBody());
    const ev = d1.raw.prepare('SELECT outcome, failure_reason FROM auth_audit_log ORDER BY id').all() as { outcome: string; failure_reason: string | null }[];
    expect(ev.map((e) => e.outcome)).toEqual(['success', 'failure']);
    expect(ev[1]!.failure_reason).toBe('auth_code_replay');
  });
});

describe('refresh_token 輪替', () => {
  async function login() {
    seedCode('c1');
    return await (await post(codeBody())).json() as { access_token: string; refresh_token: string };
  }
  const rt = (token: string, over: Record<string, string> = {}) => ({ grant_type: 'refresh_token', client_id: 'web', refresh_token: token, ...over });

  it('輪替：換到新的一對，舊 refresh 標記已用，grant family 沿用同一個 grantId', async () => {
    const first = await login();
    const res = await post(rt(first.refresh_token));
    expect(res.status).toBe(200);
    const second = await res.json() as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const grantIds = new Set(rows('RefreshToken').map((r) => JSON.parse(r.payload).grantId));
    expect(grantIds.size).toBe(1);
  });
  it('重用已輪替的 refresh → invalid_grant，整個 family（含新發的）全部撤銷', async () => {
    const first = await login();
    const second = await (await post(rt(first.refresh_token))).json() as { refresh_token: string };
    const reuse = await post(rt(first.refresh_token));
    expect(reuse.status).toBe(400);
    expect((await err(reuse)).error).toBe('invalid_grant');
    expect(rows('AccessToken')).toHaveLength(0);
    expect(rows('RefreshToken')).toHaveLength(0);
    expect((await post(rt(second.refresh_token))).status).toBe(400);
  });
  it('別的 client 拿 refresh：拒絕，且不撤銷受害者的 family', async () => {
    const first = await login();
    const res = await post(rt(first.refresh_token, { client_id: 'other' }));
    expect(res.status).toBe(400);
    expect(rows('RefreshToken').filter((r) => !JSON.parse(r.payload).consumed)).toHaveLength(1);
    expect((await post(rt(first.refresh_token))).status).toBe(200);
  });
  it('可縮小 scope，不可放寬', async () => {
    const first = await login();
    const widen = await post(rt(first.refresh_token, { scope: 'openid email' }));
    expect((await err(widen)).error).toBe('invalid_scope');
    const narrow = await post(rt(first.refresh_token, { scope: 'openid' }));
    expect(((await narrow.json()) as J).scope).toBe('openid');
  });
  it('缺 / 不存在 / 過期的 refresh_token', async () => {
    expect((await err(await post(rt('')))).error).toBe('invalid_request');
    expect((await err(await post(rt('nope')))).error).toBe('invalid_grant');
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('RefreshToken', 'exp', ?, ?)").run(JSON.stringify({ client_id: 'web', user_id: 'u1', scopes: ['openid'], grantId: 'g' }), NOW - 1);
    expect((await err(await post(rt('exp')))).error).toBe('invalid_grant');
  });
  it('access token 的 id 不能當 refresh token 用', async () => {
    const first = await login();
    expect((await err(await post(rt(first.access_token)))).error).toBe('invalid_grant');
  });
});

describe('rate limit', () => {
  it('同一 IP 超過 50 次 → 429 + Retry-After（扁平 rate_limited）', async () => {
    let last!: Response;
    for (let i = 0; i < 52; i++) last = await post({ grant_type: 'password', client_id: 'web' }, { ip: '9.9.9.9' });
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await err(last)).error).toBe('rate_limited');
    // 別的 IP 不受影響
    expect((await post({ grant_type: 'password', client_id: 'web' }, { ip: '8.8.8.8' })).status).toBe(400);
  });
  it('每個 client 每分鐘上限 100（以 client 為單位，與 IP 無關）', async () => {
    let last!: Response;
    for (let i = 0; i < 102; i++) last = await post({ grant_type: 'authorization_code', client_id: 'other', code: 'nope' }, { ip: `7.7.${i % 250}.${Math.floor(i / 250)}` });
    expect(last.status).toBe(429);
  });
});
