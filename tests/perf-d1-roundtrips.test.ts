/**
 * #87：關鍵路徑上的 D1 循序往返數守門（token refresh 與典型已授權 GET，皆為 production 的真實形態：DPoP 綁定）。
 * 每個請求的往返表會印在輸出（console.table）；上限鎖住「不得退回循序」。
 * deferred（waitUntil）的寫入在斷言前一定 flush 完，並驗證它們真的有落地（稽核不可遺失）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';
import { fakeCtx, traceD1 } from './support/d1-trace';
import { athOf, newKey, proof, type DpopKey } from './support/dpop';

let d1: ReturnType<typeof createD1>;
let tr: ReturnType<typeof traceD1>;
let slowBuckets = false;
let env: Env;
let key: DpopKey;
let SIGN_KEY: string;
const ORIGIN = 'http://localhost';
const ACCESS = 'a'.repeat(48);
const REFRESH = 'r'.repeat(48);
const table: Record<string, unknown>[] = [];

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  SIGN_KEY = Buffer.from((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer).toString('base64');
  key = await newKey();
});
beforeEach(() => {
  d1 = createD1();
  slowBuckets = false;
  tr = traceD1(d1.db, 25, (sql) => (slowBuckets && /rate_limit_buckets/.test(sql) ? 300 : 0));
  env = { DB: tr.db, ALLOWED_ORIGINS: '', PUBLIC_ORIGIN: ORIGIN, OAUTH_SIGNING_PRIVATE_KEY: SIGN_KEY } as Env;
  d1.raw.prepare("INSERT INTO users (id, email, display_name) VALUES ('u1', 'a@example.com', 'A')").run();
  d1.raw.prepare(`INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status, first_party) VALUES ('web', 'public', 'web', '["https://app.example/cb"]', '["openid","profile"]', 'active', 1)`).run();
  const exp = Date.now() + 600_000;
  const base = { client_id: 'web', user_id: 'u1', scopes: ['openid', 'profile'], grantId: 'g1', cnf: { jkt: key.jkt } };
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, ?)").run(ACCESS, JSON.stringify(base), exp);
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('RefreshToken', ?, ?, ?)").run(REFRESH, JSON.stringify(base), exp);
});
afterEach(() => d1.close());

async function run(label: string, send: (ctx: ExecutionContext) => Promise<Response>) {
  const { ctx, flush } = fakeCtx();
  const res = await send(ctx);
  const at = performance.now();
  const crit = tr.critical(at);
  await flush();
  const total = tr.calls.length;
  table.push({ 請求: label, 循序往返: crit.roundTrips, 回應前查詢數: crit.queries, 其中寫入: crit.writes, 回應後才完成: total - crit.queries });
  return { res, crit, flush };
}

async function authedGet(path: string, ctx: ExecutionContext) {
  const url = `${ORIGIN}${path}`;
  const p = await proof(key, { htm: 'GET', htu: url, ath: athOf(ACCESS) });
  return createApp().request(url, { headers: { Authorization: `DPoP ${ACCESS}`, DPoP: p, 'CF-Connecting-IP': '1.1.1.1' } }, env, ctx);
}

describe('安全語意不因併發／合批而改變', () => {
  it('同一個 refresh token 並發使用：只有一個成功，另一個 invalid_grant 並撤銷整個 family', async () => {
    const send = async () => {
      const { ctx, flush } = fakeCtx();
      const p = await proof(key, { htm: 'POST', htu: `${ORIGIN}/api/oauth/token` });
      const res = await createApp().request(`${ORIGIN}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: p, 'CF-Connecting-IP': '1.1.1.1' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'web', refresh_token: REFRESH }).toString(),
      }, env, ctx);
      await flush();
      return res;
    };
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const loser = a.status === 400 ? a : b;
    expect(((await loser.json()) as { error: string }).error).toBe('invalid_grant');
    // family 全撤銷：AccessToken 一個不剩（含種子與剛發的）
    expect((d1.raw.prepare("SELECT count(*) AS n FROM oauth_models WHERE name='AccessToken'").get() as { n: number }).n).toBe(0);
  });

  it('資源端 DPoP：token 不存在（或金鑰不符）時，jti 不會被登記；有效請求才登記一次，重放被拒', async () => {
    const jtis = () => (d1.raw.prepare("SELECT count(*) AS n FROM oauth_models WHERE name='DPoPJti'").get() as { n: number }).n;
    const get = async (token: string, k: DpopKey, jti = crypto.randomUUID()) => {
      const url = `${ORIGIN}/api/account/stats`;
      const p = await proof(k, { htm: 'GET', htu: url, ath: athOf(token), jti });
      return createApp().request(url, { headers: { Authorization: `DPoP ${token}`, DPoP: p } }, env);
    };
    expect((await get('z'.repeat(48), key)).status).toBe(401);
    expect(jtis()).toBe(0);
    expect((await get(ACCESS, await newKey())).status).toBe(401);
    expect(jtis()).toBe(0);
    expect((await get(ACCESS, key, 'j1')).status).toBe(200);
    expect(jtis()).toBe(1);
    expect((await get(ACCESS, key, 'j1')).status).toBe(401);
    expect(jtis()).toBe(1);
  });
});

describe('D1 往返（關鍵路徑）', () => {
  it('POST /api/oauth/token refresh_token（DPoP、openid）', async () => {
    const { res, crit } = await run('POST /api/oauth/token (refresh)', async (ctx) => {
      const p = await proof(key, { htm: 'POST', htu: `${ORIGIN}/api/oauth/token` });
      return createApp().request(`${ORIGIN}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: p, 'CF-Connecting-IP': '1.1.1.1' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'web', refresh_token: REFRESH }).toString(),
      }, env, ctx);
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_type: 'DPoP' });
    // 稽核與限流計數不可遺失：flush 後都要在
    const n = (sql: string) => (d1.raw.prepare(sql).get() as { n: number }).n;
    expect(n("SELECT count(*) AS n FROM auth_audit_log WHERE event_type='token_issue' AND outcome='success'")).toBe(1);
    expect(n("SELECT count(*) AS n FROM rate_limit_buckets WHERE bucket_key LIKE 'oauth-token:%'")).toBe(2);
    expect(n("SELECT count(*) AS n FROM oauth_models WHERE name='DPoPJti'")).toBe(1);
    expect(crit.roundTrips).toBeLessThanOrEqual(5);
  });

  for (const [path, max] of [['/api/account/stats', 2], ['/api/my-trips', 2], ['/api/oauth/userinfo', 2], ['/api/account/ai-data-consent', 2], ['/api/account', 2]] as const) {
    it(`GET ${path}（DPoP）`, async () => {
      const { res, crit } = await run(`GET ${path}`, (ctx) => authedGet(path, ctx));
      expect(res.status).toBe(200);
      expect(crit.roundTrips).toBeLessThanOrEqual(max);
    });
  }

  it('Bearer（未綁定）GET /api/account/stats', async () => {
    d1.raw.prepare("UPDATE oauth_models SET payload = json_remove(payload, '$.cnf') WHERE name='AccessToken'").run();
    const { res, crit } = await run('GET /api/account/stats (Bearer)', async (ctx) =>
      createApp().request(`${ORIGIN}/api/account/stats`, { headers: { Authorization: `Bearer ${ACCESS}` } }, env, ctx));
    expect(res.status).toBe(200);
    expect(crit.roundTrips).toBeLessThanOrEqual(2);
  });

  it('限流計數寫入慢也要在回應前落地（只是不排在關鍵路徑上，沒有被丟到 waitUntil）', async () => {
    slowBuckets = true;
    const { ctx } = fakeCtx();
    const p = await proof(key, { htm: 'POST', htu: `${ORIGIN}/api/oauth/token` });
    const res = await createApp().request(`${ORIGIN}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: p, 'CF-Connecting-IP': '1.1.1.1' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'web', refresh_token: REFRESH }).toString(),
    }, env, ctx); // 不 flush：回應一回來就必須已經計數
    expect(res.status).toBe(200);
    const n = (d1.raw.prepare("SELECT count(*) AS n FROM rate_limit_buckets WHERE bucket_key LIKE 'oauth-token:%'").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it('（輸出）往返表', () => {
    // eslint-disable-next-line no-console
    console.table(table);
  });
});
