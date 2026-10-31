/**
 * DPoP（RFC 9449，拆分 T9）：token 綁定 client 金鑰。
 * 走 HTTP 邊界：token endpoint 收 DPoP header 並綁定；資源端點以 `Authorization: DPoP` + proof 驗證。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import { bearerAuth, requireAuth } from '../src/auth';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';
import { athOf, newKey, proof, type DpopKey, type ProofOpts } from './support/dpop';

let d1: ReturnType<typeof createD1>;
let env: Env;
let key: DpopKey;
let other: DpopKey;
let SECRET_HASH: string;
beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  key = await newKey(); other = await newKey();
  SECRET_HASH ??= await hashPassword('s3cret-value');
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
  for (const id of ['web', 'legacy']) d1.raw.prepare(`INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status) VALUES (?, 'public', ?, '["https://app.example/cb"]', '["openid","profile"]', 'active')`).run(id, id);
  d1.raw.prepare(`INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status) VALUES ('svc', ?, 'confidential', 'svc', '[]', '["ops:read"]', 'active')`).run(SECRET_HASH);
});
afterEach(() => d1.close());

const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const NOW = Date.now();
function seedCode(code: string, over: Record<string, unknown> = {}) {
  const payload = { client_id: 'web', user_id: 'u1', redirect_uri: 'https://app.example/cb', scopes: ['openid', 'profile'], code_challenge: CHALLENGE, code_challenge_method: 'S256', ...over };
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AuthorizationCode', ?, ?, ?)").run(code, JSON.stringify(payload), NOW + 60_000);
}
const rows = (name: string) => d1.raw.prepare('SELECT id, payload FROM oauth_models WHERE name = ?').all(name) as { id: string; payload: string }[];
type J = Record<string, unknown>;

function token(body: Record<string, string>, dpop?: string | string[], e: Env = env) {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '1.1.1.1' });
  for (const p of dpop === undefined ? [] : Array.isArray(dpop) ? dpop : [dpop]) headers.append('DPoP', p);
  return createApp().request('/api/oauth/token', { method: 'POST', headers, body: new URLSearchParams(body).toString() }, e);
}
const codeBody = (over: Record<string, string> = {}) => ({ grant_type: 'authorization_code', client_id: 'web', code: 'c1', redirect_uri: 'https://app.example/cb', code_verifier: VERIFIER, ...over });
const errOf = async (res: Response) => (await res.json()) as { error: string };

describe('token endpoint 綁定', () => {
  it('帶合法 proof → token_type=DPoP，access 與 refresh 都記 cnf.jkt', async () => {
    seedCode('c1');
    const res = await token(codeBody(), await proof(key));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_type: 'DPoP' });
    for (const n of ['AccessToken', 'RefreshToken']) expect(JSON.parse(rows(n)[0]!.payload).cnf).toEqual({ jkt: key.jkt });
  });

  it('沒帶 proof 且 client 不在強制名單 → 照舊 Bearer，payload 無 cnf', async () => {
    seedCode('c1');
    const res = await token(codeBody());
    expect(await res.json()).toMatchObject({ token_type: 'Bearer' });
    expect(JSON.parse(rows('AccessToken')[0]!.payload).cnf).toBeUndefined();
  });

  it('client 在 DPOP_REQUIRED_CLIENTS 名單，沒帶 proof → 400 invalid_dpop_proof，不消耗 code', async () => {
    seedCode('c1');
    const res = await token(codeBody(), undefined, { ...env, DPOP_REQUIRED_CLIENTS: 'legacy, web' });
    expect(res.status).toBe(400);
    expect((await errOf(res)).error).toBe('invalid_dpop_proof');
    expect(rows('AccessToken')).toHaveLength(0);
    expect(JSON.parse(rows('AuthorizationCode')[0]!.payload).consumed).toBeUndefined();
  });

  it('名單比對是精確的（web 不會因為名單有 website 而被強制）', async () => {
    seedCode('c1');
    const res = await token(codeBody(), undefined, { ...env, DPOP_REQUIRED_CLIENTS: 'website' });
    expect(res.status).toBe(200);
  });

  it('client_credentials 也可綁定', async () => {
    const res = await token({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 's3cret-value' }, await proof(key));
    expect(await res.json()).toMatchObject({ token_type: 'DPoP' });
    expect(JSON.parse(rows('AccessToken')[0]!.payload).cnf).toEqual({ jkt: key.jkt });
  });

  describe('無效 proof 一律 400 invalid_dpop_proof，且不發 token、不消耗 code', () => {
    const bad: [string, () => Promise<string | string[]>][] = [
      ['typ 不是 dpop+jwt', () => proof(key, { typ: 'JWT' })],
      ['alg=none', () => proof(key, { alg: 'none' })],
      ['alg=HS256', () => proof(key, { alg: 'HS256' })],
      ['alg=RS256', () => proof(key, { alg: 'RS256' })],
      ['jwk 含私鑰成員 d', async () => proof(key, { jwk: { ...key.jwk, d: 'abc' } })],
      ['jwk 不是 EC P-256', async () => proof(key, { jwk: { ...key.jwk, crv: 'P-384' } })],
      ['簽章金鑰與 jwk 不同', () => proof(key, { signWith: other.privateKey })],
      ['htm 不符', () => proof(key, { htm: 'GET' })],
      ['htu 路徑不符', () => proof(key, { htu: 'http://localhost/api/other' })],
      ['htu 主機不符', () => proof(key, { htu: 'https://evil.example/api/oauth/token' })],
      ['iat 太舊', () => proof(key, { iat: Math.floor(Date.now() / 1000) - 600 })],
      ['iat 在未來', () => proof(key, { iat: Math.floor(Date.now() / 1000) + 600 })],
      ['缺 jti', () => proof(key, { jti: null })],
      ['缺 iat', () => proof(key, { omit: ['iat'] })],
      ['缺 htm', () => proof(key, { omit: ['htm'] })],
      ['缺 htu', () => proof(key, { omit: ['htu'] })],
      ['不是 JWT', async () => 'not-a-jwt'],
      ['過長', async () => 'a.'.repeat(5000)],
      ['兩個 DPoP header', async () => [await proof(key), await proof(key)]],
    ];
    for (const [name, make] of bad) {
      it(name, async () => {
        seedCode('c1');
        const res = await token(codeBody(), await make());
        expect(res.status).toBe(400);
        expect((await errOf(res)).error).toBe('invalid_dpop_proof');
        expect(rows('AccessToken')).toHaveLength(0);
        expect(JSON.parse(rows('AuthorizationCode')[0]!.payload).consumed).toBeUndefined();
      });
    }
  });

  it('htu 帶 query／fragment 不影響（比對時忽略）', async () => {
    seedCode('c1');
    const res = await token(codeBody(), await proof(key, { htu: 'http://localhost/api/oauth/token?x=1#f' }));
    expect(res.status).toBe(200);
  });

  it('同一個 jti 不可重複使用（重放）', async () => {
    seedCode('c1'); seedCode('c2');
    const p = await proof(key, { jti: 'fixed-jti' });
    expect((await token(codeBody(), p)).status).toBe(200);
    const again = await token(codeBody({ code: 'c2' }), p);
    expect(again.status).toBe(400);
    expect((await errOf(again)).error).toBe('invalid_dpop_proof');
  });

  it('不同金鑰可用相同 jti 字串（jti 以金鑰為範圍）', async () => {
    seedCode('c1'); seedCode('c2');
    expect((await token(codeBody(), await proof(key, { jti: 'same' }))).status).toBe(200);
    expect((await token(codeBody({ code: 'c2' }), await proof(other, { jti: 'same' }))).status).toBe(200);
  });

  it('無效 proof 不會寫入 jti 紀錄（不能被當寫入放大器）', async () => {
    seedCode('c1');
    await token(codeBody(), await proof(key, { htm: 'GET' }));
    expect(rows('DPoPJti')).toHaveLength(0);
  });

  it('code 授權時已綁 dpop_jkt：proof 金鑰不同或沒帶 → invalid_grant', async () => {
    seedCode('c1', { dpop_jkt: key.jkt });
    expect((await errOf(await token(codeBody(), await proof(other)))).error).toBe('invalid_grant');
    expect((await errOf(await token(codeBody()))).error).toBe('invalid_grant');
    expect((await token(codeBody(), await proof(key))).status).toBe(200);
  });
});

describe('refresh token 綁定', () => {
  async function login(k: DpopKey | null) {
    seedCode('c1');
    return await (await token(codeBody(), k ? await proof(k) : undefined)).json() as { access_token: string; refresh_token: string };
  }
  const rt = (t: string) => ({ grant_type: 'refresh_token', client_id: 'web', refresh_token: t });

  it('同一把金鑰輪替成功，新 token 仍綁同一把', async () => {
    const first = await login(key);
    const res = await token(rt(first.refresh_token), await proof(key));
    expect(res.status).toBe(200);
    const unconsumed = rows('RefreshToken').filter((r) => !JSON.parse(r.payload).consumed);
    expect(JSON.parse(unconsumed[0]!.payload).cnf).toEqual({ jkt: key.jkt });
  });
  it('換一把金鑰 → invalid_grant，且不連坐撤銷（原持有者仍可繼續用）', async () => {
    const first = await login(key);
    const res = await token(rt(first.refresh_token), await proof(other));
    expect(res.status).toBe(400);
    expect((await errOf(res)).error).toBe('invalid_grant');
    expect((await token(rt(first.refresh_token), await proof(key))).status).toBe(200);
  });
  it('綁定的 refresh 不帶 proof → invalid_grant（不可降級成 Bearer 換 token）', async () => {
    const first = await login(key);
    expect((await errOf(await token(rt(first.refresh_token)))).error).toBe('invalid_grant');
  });
  it('未綁定的 refresh 帶 proof 輪替 → 新 token 變成綁定（升級路徑）', async () => {
    const first = await login(null);
    const res = await token(rt(first.refresh_token), await proof(key));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_type: 'DPoP' });
  });
});

describe('資源端點', () => {
  const URL_ = 'http://localhost/x';
  function app() {
    const a = createApp();
    a.use('/x', bearerAuth, requireAuth);
    a.get('/x', (c) => c.json({ ok: true }));
    return a;
  }
  function seedBound(id: string, jkt: string | null) {
    const payload: J = { client_id: 'web', user_id: 'u1', scopes: ['openid'], grantId: 'g' };
    if (jkt) payload.cnf = { jkt };
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, ?)").run(id, JSON.stringify(payload), NOW + 3600_000);
  }
  async function call(scheme: string, tok: string, p?: string | ProofOpts & { key?: DpopKey }, k: DpopKey = key) {
    const headers = new Headers({ Authorization: `${scheme} ${tok}` });
    if (typeof p === 'string') headers.set('DPoP', p);
    else if (p !== undefined || false) headers.set('DPoP', await proof(p?.key ?? k, { htm: 'GET', htu: URL_, ath: athOf(tok), ...p }));
    return app().request('/x', { headers }, env);
  }

  it('綁定的 token + DPoP scheme + 正確 proof → 200', async () => {
    seedBound('t1', key.jkt);
    expect((await call('DPoP', 't1', {})).status).toBe(200);
  });
  it('scheme 不分大小寫', async () => {
    seedBound('t1', key.jkt);
    expect((await call('dpop', 't1', {})).status).toBe(200);
  });
  it('綁定的 token 不可當 Bearer 用（外洩的 token 不能降級）', async () => {
    seedBound('t1', key.jkt);
    const res = await call('Bearer', 't1');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/DPoP/);
  });
  it('未綁定的 token 仍可 Bearer（過渡期相容）', async () => {
    seedBound('t0', null);
    expect((await call('Bearer', 't0')).status).toBe(200);
  });
  it('未綁定的 token 不可走 DPoP scheme', async () => {
    seedBound('t0', null);
    expect((await call('DPoP', 't0', {})).status).toBe(401);
  });

  const reject: [string, (tok: string) => Promise<Response>][] = [
    ['DPoP scheme 沒帶 proof', (t) => call('DPoP', t)],
    ['proof 金鑰與綁定不同（token 被偷但沒有私鑰）', (t) => call('DPoP', t, { key: other })],
    ['ath 不符（proof 是給別的 token 的）', (t) => call('DPoP', t, { ath: athOf('another') })],
    ['缺 ath', (t) => call('DPoP', t, { omit: ['ath'] } as never)],
    ['htm 不符', (t) => call('DPoP', t, { htm: 'POST' })],
    ['htu 不符（proof 被拿去打別的端點）', (t) => call('DPoP', t, { htu: 'http://localhost/y' })],
    ['iat 太舊', (t) => call('DPoP', t, { iat: Math.floor(Date.now() / 1000) - 600 })],
  ];
  for (const [name, fn] of reject) {
    it(`401：${name}`, async () => {
      seedBound('t1', key.jkt);
      const res = await fn('t1');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^DPoP/);
    });
  }

  it('同一個 proof 不可重放', async () => {
    seedBound('t1', key.jkt);
    const p = await proof(key, { htm: 'GET', htu: URL_, ath: athOf('t1') });
    expect((await call('DPoP', 't1', p)).status).toBe(200);
    expect((await call('DPoP', 't1', p)).status).toBe(401);
  });
  it('端到端：token endpoint 發的綁定 token 能打資源端點', async () => {
    seedCode('c1');
    const { access_token } = await (await token(codeBody(), await proof(key))).json() as { access_token: string };
    expect((await call('DPoP', access_token, {})).status).toBe(200);
    expect((await call('Bearer', access_token)).status).toBe(401);
  });
});
