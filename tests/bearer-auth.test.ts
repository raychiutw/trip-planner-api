/**
 * Bearer 認證（拆分 T9）：Authorization: Bearer <opaque access token> → AuthData。
 * 走 HTTP 邊界（app.request），token 存在真 SQLite 的 oauth_models（套用全部 migrations）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { bearerAuth, requireAuth, optionalAuth } from '../src/auth';
import type { Env } from '../src/env';
import type { AuthData } from '../src/types';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
beforeEach(() => { d1 = createD1(); env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env; });
afterEach(() => d1.close());

const NOW = Date.now();
function seedUser(id = 'u1', email = 'Alice@Example.com', status = 'active') {
  d1.raw.prepare('INSERT INTO users (id, email, status) VALUES (?, ?, ?)').run(id, email, status);
}
function seedToken(id: string, payload: Record<string, unknown>, expiresAtMs = NOW + 3600_000, name = 'AccessToken') {
  d1.raw.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)').run(name, id, JSON.stringify(payload), expiresAtMs);
}
const userToken = { client_id: 'web', user_id: 'u1', scopes: ['openid'], grantId: 'g1' };

function appWithRoutes() {
  const app = createApp();
  app.use('/priv/*', bearerAuth, requireAuth);
  app.get('/priv/me', (c) => c.json(c.get('auth')));
  app.use('/pub/*', bearerAuth, optionalAuth);
  app.get('/pub/x', (c) => c.json({ auth: c.get('auth') ?? null }));
  return app;
}
const get = (path: string, token?: string, extra: Record<string, string> = {}) =>
  appWithRoutes().request(path, { headers: { ...(token === undefined ? {} : { Authorization: token }), ...extra } }, env);

describe('合法 token', () => {
  it('使用者 token → AuthData（email 正規化為小寫、userId、scopes、clientId）', async () => {
    seedUser(); seedToken('tok-1', userToken);
    const res = await get('/priv/me', 'Bearer tok-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'alice@example.com', userId: 'u1', isServiceToken: false, scopes: ['openid'], clientId: 'web' });
  });

  it('service token（user_id null）→ isServiceToken、email 為 service:<client> 哨兵，不繼承任何 email', async () => {
    seedToken('svc-1', { client_id: 'cron', user_id: null, scopes: ['ops:read'], grantId: 'g2' });
    const auth = await (await get('/priv/me', 'Bearer svc-1')).json() as AuthData;
    expect(auth).toMatchObject({ userId: null, isServiceToken: true, email: 'service:cron', scopes: ['ops:read'] });
  });

  it('restrict_trip 帶進 restrictTrip；第一方 client 標記 isFirstPartyClient', async () => {
    seedUser();
    seedToken('tok-r', { client_id: 'tripline-tp-request', user_id: 'u1', scopes: [], grantId: 'g3', restrict_trip: 'trip-9' });
    expect(await (await get('/priv/me', 'Bearer tok-r')).json()).toMatchObject({ restrictTrip: 'trip-9', isFirstPartyClient: true });
    seedToken('tok-n', userToken);
    expect(await (await get('/priv/me', 'Bearer tok-n')).json()).toMatchObject({ isFirstPartyClient: false });
  });

  it('scheme 不分大小寫（RFC 7235）', async () => {
    seedUser(); seedToken('tok-1', userToken);
    expect((await get('/priv/me', 'bearer tok-1')).status).toBe(200);
  });
});

describe('一律 401 AUTH_REQUIRED（回應形狀相同，不洩漏失敗原因）', () => {
  async function expect401(res: Response) {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: '請先登入' } });
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  }

  it('沒帶 Authorization', async () => { await expect401(await get('/priv/me')); });
  it('不是 Bearer（Basic、無 scheme）', async () => {
    seedToken('tok-1', userToken); seedUser();
    await expect401(await get('/priv/me', 'Basic dG9rLTE6'));
    await expect401(await get('/priv/me', 'tok-1'));
  });
  it('空 token、只有空白', async () => {
    await expect401(await get('/priv/me', 'Bearer '));
    await expect401(await get('/priv/me', 'Bearer    '));
  });
  it('不存在的 token', async () => { await expect401(await get('/priv/me', 'Bearer nope')); });
  it('過期的 token', async () => {
    seedUser(); seedToken('old', userToken, NOW - 1000);
    await expect401(await get('/priv/me', 'Bearer old'));
  });
  it('不是 AccessToken 的 row（RefreshToken、AuthorizationCode 的 id 不能當 access token 用）', async () => {
    seedUser();
    seedToken('refresh-1', userToken, NOW + 3600_000, 'RefreshToken');
    seedToken('code-1', userToken, NOW + 3600_000, 'AuthorizationCode');
    await expect401(await get('/priv/me', 'Bearer refresh-1'));
    await expect401(await get('/priv/me', 'Bearer code-1'));
  });
  it('使用者已被刪除（token 還在但 user 不在）→ fail-closed', async () => {
    seedToken('ghost', { ...userToken, user_id: 'deleted-user' });
    await expect401(await get('/priv/me', 'Bearer ghost'));
  });
  it('使用者被停權（suspended）', async () => {
    seedUser('u2', 'b@example.com', 'suspended'); seedToken('sus', { ...userToken, user_id: 'u2' });
    await expect401(await get('/priv/me', 'Bearer sus'));
  });
  it('payload 殘缺（沒有 client_id／user_id 欄位）→ 拒絕，不是 500', async () => {
    seedToken('bad1', { scopes: ['x'] });
    seedToken('bad2', 'not-an-object' as never);
    await expect401(await get('/priv/me', 'Bearer bad1'));
    await expect401(await get('/priv/me', 'Bearer bad2'));
  });
  it('過長 token（>512 字元）在查 DB 前就拒絕', async () => {
    let queried = 0;
    const spy = { prepare: () => { queried++; throw new Error('不該查 DB'); } } as unknown as D1Database;
    const res = await appWithRoutes().request('/priv/me', { headers: { Authorization: `Bearer ${'a'.repeat(513)}` } }, { DB: spy } as Env);
    await expect401(res);
    expect(queried).toBe(0);
  });
  it('DB 查詢拋錯 → 401（fail-closed，不放行、不 500 洩漏）', async () => {
    const broken = { prepare: () => { throw new Error('D1_ERROR boom'); } } as unknown as D1Database;
    const res = await appWithRoutes().request('/priv/me', { headers: { Authorization: 'Bearer x' } }, { DB: broken } as Env);
    await expect401(res);
  });
  it('SQL 注入樣式的 token 只是不存在的 token', async () => {
    seedUser(); seedToken('tok-1', userToken);
    await expect401(await get('/priv/me', "Bearer ' OR '1'='1"));
  });
});

describe('optionalAuth（公開讀取）', () => {
  it('沒帶 token → 放行且 auth 為空', async () => {
    const res = await get('/pub/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auth: null });
  });
  it('帶合法 token → auth 有值', async () => {
    seedUser(); seedToken('tok-1', userToken);
    expect(((await (await get('/pub/x', 'Bearer tok-1')).json()) as { auth: AuthData }).auth.userId).toBe('u1');
  });
  it('帶無效 token → 仍是 401（不可悄悄降級成匿名，否則 client 以為自己登入了）', async () => {
    expect((await get('/pub/x', 'Bearer nope')).status).toBe(401);
  });
});

describe('CSRF／來源', () => {
  it('Bearer 請求若帶 Origin，必須在白名單（被竊的 token 不能從 evil.com 用）', async () => {
    seedUser(); seedToken('tok-1', userToken);
    const e = { DB: d1.db, ALLOWED_ORIGINS: 'https://web.example' } as Env;
    const ok = await appWithRoutes().request('/priv/me', { headers: { Authorization: 'Bearer tok-1', Origin: 'https://web.example' } }, e);
    expect(ok.status).toBe(200);
    const bad = await appWithRoutes().request('/priv/me', { headers: { Authorization: 'Bearer tok-1', Origin: 'https://evil.example' } }, e);
    expect(bad.status).toBe(403);
  });
});
