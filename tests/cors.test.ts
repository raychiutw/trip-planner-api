/**
 * CORS：只允許 web 的 origin（拆分 T9）。
 * 認證是 bearer token 不是 cookie，所以不允許 credentials；非 web origin 的跨站請求不只是不回 CORS 標頭，而是直接拒絕。
 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';

const WEB = 'https://trip-planner-dby.pages.dev';
const UAT = 'https://uat.trip-planner-dby.pages.dev';
const env = (allowed = `${WEB},${UAT}`) => ({ DB: {} as D1Database, ALLOWED_ORIGINS: allowed } as Env);

function app() {
  const a = createApp();
  a.get('/x', (c) => c.json({ ok: true }));
  a.post('/x', (c) => c.json({ ok: true }));
  return a;
}
const get = (origin?: string, e = env()) => app().request('/x', origin === undefined ? {} : { headers: { Origin: origin } }, e);

describe('CORS 白名單', () => {
  it('允許的 web origin：回 Allow-Origin（精確回該 origin，不是 *）並帶 Vary: Origin', async () => {
    const res = await get(WEB);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('vary')).toMatch(/Origin/i);
  });

  it('白名單內的另一個 origin（UAT）也允許，且各自只回自己', async () => {
    expect((await get(UAT)).headers.get('access-control-allow-origin')).toBe(UAT);
  });

  it('沒有 Origin（mobile、伺服器對伺服器）→ 放行，不加 CORS 標頭', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('不在白名單的 origin → 403 PERM_DENIED，沒有 CORS 標頭', async () => {
    const res = await get('https://evil.example');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'PERM_DENIED' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('精確比對：子網域、前綴、後綴、不同 scheme／port、大小寫都不算', async () => {
    for (const o of [
      `${WEB}.evil.example`, `https://evil.${WEB.slice(8)}`, 'http://trip-planner-dby.pages.dev',
      `${WEB}:8443`, `${WEB}/`, 'https://TRIP-PLANNER-DBY.pages.dev.', 'null', '*', '',
    ]) {
      const res = await get(o);
      expect(res.status, `origin=${JSON.stringify(o)}`).toBe(403);
    }
  });

  it('沒設定 ALLOWED_ORIGINS → 任何帶 Origin 的跨站請求都被拒（預設封閉）', async () => {
    expect((await get(WEB, env(''))).status).toBe(403);
  });

  it('設定值裡的空白與空項目被忽略，不會變成萬用', async () => {
    const e = env(` ${WEB} , ,, `);
    expect((await get(WEB, e)).status).toBe(200);
    expect((await get('https://evil.example', e)).status).toBe(403);
    expect((await get('', e)).status, '空字串 Origin 不可被空項目吃掉').toBe(403);
  });

  it('不使用 credentials（bearer token 認證，不靠 cookie）', async () => {
    expect((await get(WEB)).headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('暴露給 web 讀取的標頭：Retry-After 與 X-Request-Id', async () => {
    expect((await get(WEB)).headers.get('access-control-expose-headers')).toMatch(/Retry-After.*X-Request-Id|X-Request-Id.*Retry-After/);
  });
});

describe('preflight', () => {
  const pre = (origin: string, extra: Record<string, string> = {}, e = env()) => app().request('/x', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type', ...extra },
  }, e);

  it('允許的 origin → 204，列出方法與標頭並快取', async () => {
    const res = await pre(WEB);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/GET.*POST.*PUT.*PATCH.*DELETE/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/i);
    expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0);
  });

  it('DPoP 請求標頭必須在允許清單（web 對 /api/oauth/token 與受保護路徑送 DPoP proof；少了瀏覽器會在預檢就擋掉）', async () => {
    const res = await pre(WEB, { 'Access-Control-Request-Headers': 'authorization, content-type, dpop' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')?.split(/,\s*/).map((h) => h.toLowerCase())).toContain('dpop');
  });

  it('不在白名單的 origin → 403，不洩漏允許的方法與標頭', async () => {
    const res = await pre('https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('對不存在的路徑做 preflight 也一樣處理（不因 404 而繞過檢查）', async () => {
    const res = await app().request('/nope', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } }, env());
    expect(res.status).toBe(403);
  });
});
