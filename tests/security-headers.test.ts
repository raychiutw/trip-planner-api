/** 所有回應帶一致的安全標頭（拆分 T9）：成功、錯誤、404、preflight 都一樣。 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { AppError } from '../src/errors';
import type { Env } from '../src/env';

const ENV = { DB: {} as D1Database, ALLOWED_ORIGINS: 'https://web.example' } as Env;
const REQUIRED: Record<string, string | RegExp> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': /max-age=\d{7,}; includeSubDomains/,
  'content-security-policy': /default-src 'none'.*frame-ancestors 'none'/,
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': /camera=\(\)/,
};

function expectHeaders(res: Response, label: string) {
  for (const [name, want] of Object.entries(REQUIRED)) {
    const got = res.headers.get(name);
    expect(got, `${label}：缺 ${name}`).not.toBeNull();
    if (typeof want === 'string') expect(got, `${label}：${name}`).toBe(want);
    else expect(got, `${label}：${name}`).toMatch(want);
  }
}

describe('安全標頭', () => {
  it('成功回應', async () => {
    const app = createApp();
    app.get('/ok', (c) => c.json({ ok: true }));
    expectHeaders(await app.request('/ok', {}, ENV), '200');
  });

  it('AppError 回應（4xx、5xx）', async () => {
    const app = createApp();
    app.get('/e4', () => { throw new AppError('PERM_DENIED'); });
    app.get('/e5', () => { throw new Error('x'); });
    expectHeaders(await app.request('/e4', {}, ENV), '403');
    expectHeaders(await app.request('/e5', {}, ENV), '500');
  });

  it('404', async () => {
    expectHeaders(await createApp().request('/nope', {}, ENV), '404');
  });

  it('CORS preflight（204）與被拒的跨站請求（403）', async () => {
    const app = createApp();
    app.get('/ok', (c) => c.json({}));
    const pre = await app.request('/ok', { method: 'OPTIONS', headers: { Origin: 'https://web.example', 'Access-Control-Request-Method': 'GET' } }, ENV);
    expect(pre.status).toBe(204);
    expectHeaders(pre, 'preflight');
    const denied = await app.request('/ok', { headers: { Origin: 'https://evil.example' } }, ENV);
    expect(denied.status).toBe(403);
    expectHeaders(denied, 'cross-site denied');
  });

  it('API 回應預設不可快取（no-store）；handler 自己設的 Cache-Control 不被蓋掉', async () => {
    const app = createApp();
    app.get('/default', (c) => c.json({}));
    app.get('/doc', (c) => c.json({}, 200, { 'Cache-Control': 'public, max-age=3600' }));
    expect((await app.request('/default', {}, ENV)).headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/doc', {}, ENV)).headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('不洩漏伺服器資訊（沒有 Server／X-Powered-By）', async () => {
    const res = await createApp().request('/nope', {}, ENV);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('server')).toBeNull();
  });
});
