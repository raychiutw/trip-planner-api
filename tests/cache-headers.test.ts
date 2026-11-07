/**
 * 已登入回應的快取標頭（#1599，承接 web #1437）
 *
 * PWA 的 cacheWillUpdate 以請求 Cookie 標頭判斷登入，Service Worker 讀不到，回應標頭才是可靠訊號。規則：
 *   - 有登入身分（c.get('auth') 非 null）的回應 → private, no-store；handler 不能用 public 蓋掉
 *   - 沒有登入身分的回應維持原樣：預設 no-store，handler 自訂的（public-config 等）照舊
 * 走 HTTP 邊界（app.request）+ 真 SQLite。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { bearerAuth, requireAuth } from '../src/auth';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
beforeEach(() => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  d1.raw.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@example.com', 'active')").run();
  d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id, published) VALUES ('t1', 'T', 'u1', 0)").run();
  d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('u1', 't1', 'owner')").run();
  d1.raw.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)').run(
    'AccessToken', 'tok', JSON.stringify({ client_id: 'web', user_id: 'u1', scopes: ['trips:read'], grantId: 'g1' }), Date.now() + 3600_000,
  );
});
afterEach(() => d1.close());

const authed = { headers: { Authorization: 'Bearer tok' } };
const cc = (res: Response) => res.headers.get('cache-control');

describe('已登入的回應帶 private, no-store', () => {
  it.each([
    ['行程列表（optional auth）', '/api/trips'],
    ['我的行程', '/api/my-trips'],
    ['AI 授權狀態', '/api/account/ai-authorization'],
    ['行程擁有者的 AI 授權狀態', '/api/trips/t1/ai-authorization'],
    ['行程筆記彙整（/notes）', '/api/trips/t1/notes'],
    ['行程筆記 AI 狀態（/notes/ai-state）', '/api/trips/t1/notes/ai-state'],
  ])('%s', async (_n, path) => {
    const res = await createApp().request(path, authed, env);
    expect(res.status).toBe(200);
    expect(cc(res)).toBe('private, no-store');
  });

  it('handler 自己設了 public 也會被改成 private, no-store', async () => {
    const app = createApp();
    app.use('/x/*', bearerAuth, requireAuth);
    app.get('/x/doc', (c) => c.json({}, 200, { 'Cache-Control': 'public, max-age=3600' }));
    expect(cc(await app.request('/x/doc', authed, env))).toBe('private, no-store');
  });
});

describe('SSE 長連線不改快取標頭（與 web 的 _middleware 一致，標頭由串流 handler 自己決定）', () => {
  it('已登入的 text/event-stream 自設 no-cache 不被覆寫成 private, no-store', async () => {
    const app = createApp();
    app.use('/x/*', bearerAuth, requireAuth);
    app.get('/x/sse', () => new Response('data: 1\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } }));
    const res = await app.request('/x/sse', authed, env);
    expect(res.status).toBe(200);
    expect(cc(res)).toBe('no-cache');
  });
});

describe('沒有登入身分的回應維持原樣（不誤傷公開端點）', () => {
  it('匿名 GET /api/public-config 仍是 public, max-age=60', async () => {
    const res = await createApp().request('/api/public-config', {}, env);
    expect(res.status).toBe(200);
    expect(cc(res)).toBe('public, max-age=60');
  });

  it('匿名 GET /api/trips（公開行程列表）維持原本的 no-store', async () => {
    const res = await createApp().request('/api/trips', {}, env);
    expect(res.status).toBe(200);
    expect(cc(res)).toBe('no-store');
  });

  it('帶 Bearer 呼叫公開端點（auth none，不跑 bearerAuth）仍維持 public, max-age=60', async () => {
    const res = await createApp().request('/api/public-config', authed, env);
    expect(cc(res)).toBe('public, max-age=60');
  });
});
