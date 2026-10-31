/**
 * 錯誤回應的形狀與「不洩漏內部細節」（拆分 T9）。
 * 走 HTTP 邊界（app.request）：handler 丟什麼，client 看到什麼。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoute, z } from '@hono/zod-openapi';
import { createApp } from '../src/app';
import { AppError } from '../src/errors';
import type { Env } from '../src/env';

const ENV = { DB: {} as D1Database, ALLOWED_ORIGINS: '' } as Env;

/** 掛幾條會丟各種錯的測試路由。 */
function appWith(register: (app: ReturnType<typeof createApp>) => void) {
  const app = createApp();
  register(app);
  return app;
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => errorLog.mockRestore());

describe('AppError → 巢狀錯誤形狀', () => {
  it('4xx：回 { error: { code, message, detail } }，狀態碼依 code 對照', async () => {
    const app = appWith((a) => a.get('/t', () => { throw new AppError('DATA_NOT_FOUND', '行程 abc 不存在'); }));
    const res = await app.request('/t', {}, ENV);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: { code: 'DATA_NOT_FOUND', message: '找不到這筆資料', detail: '行程 abc 不存在' } });
  });

  it('各 code 的狀態碼（抽樣）', async () => {
    const cases: [string, number][] = [['AUTH_REQUIRED', 401], ['PERM_DENIED', 403], ['DATA_VALIDATION', 400], ['DATA_CONFLICT', 409], ['SYS_RATE_LIMIT', 429], ['INVITATION_EXPIRED', 410]];
    for (const [code, status] of cases) {
      const app = appWith((a) => a.get('/t', () => { throw new AppError(code as never); }));
      expect((await app.request('/t', {}, ENV)).status, code).toBe(status);
    }
  });

  it('5xx 的 AppError：不帶 detail，即使 handler 傳了（detail 可能含 SQL 或內部路徑）', async () => {
    const app = appWith((a) => a.get('/t', () => { throw new AppError('SYS_DB_ERROR', 'D1_ERROR: no such table: users at /srv/db.ts:41'); }));
    const res = await app.request('/t', {}, ENV);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('no such table');
    expect(text).not.toContain('/srv/');
    expect(JSON.parse(text).error.detail).toBeUndefined();
  });
});

describe('未預期的例外', () => {
  it('回通用的 500，不含例外訊息、stack、檔名', async () => {
    const app = appWith((a) => a.get('/t', () => { throw new Error('SQLITE_ERROR: no such column: password_hash at /srv/handlers/login.ts:88'); }));
    const res = await app.request('/t', {}, ENV);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { code: string; message: string; detail?: unknown } };
    expect(body).toEqual({ error: { code: 'SYS_INTERNAL', message: '系統發生錯誤，已通知開發團隊' } });
  });

  it('細節只進伺服器 log，並帶 request id 以便對照；回應標頭也帶同一個 id', async () => {
    const app = appWith((a) => a.get('/t', () => { throw new Error('boom-secret-detail'); }));
    const res = await app.request('/t', {}, ENV);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const logged = errorLog.mock.calls.flat().map((x: unknown) => (x instanceof Error ? x.message : String(x))).join(' ');
    expect(logged).toContain('boom-secret-detail');
    expect(logged).toContain(id!);
  });

  it('丟出的不是 Error（字串、物件）也不洩漏', async () => {
    const app = appWith((a) => a.get('/t', () => { throw { token: 'sk-live-xyz', msg: 'leak' }; }));
    const res = await app.request('/t', {}, ENV);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/sk-live|leak/);
  });

  it('不存在的路徑 → 404 DATA_NOT_FOUND（JSON，不是預設的 text/plain）', async () => {
    const res = await createApp().request('/no-such', {}, ENV);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_NOT_FOUND' } });
  });
});

describe('輸入驗證：畸形輸入在進商業邏輯前被拒', () => {
  const route = createRoute({
    method: 'post', path: '/echo',
    request: { body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(20), age: z.number().int().min(0) }) } } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } },
  });

  function validated() {
    let reached = 0;
    const app = createApp();
    app.openapi(route, (c) => { reached++; return c.json({ ok: true }, 200); });
    return { app, reached: () => reached };
  }
  const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
    app.request('/echo', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, ENV);

  it('合法輸入進到 handler', async () => {
    const { app, reached } = validated();
    expect((await post(app, { name: 'a', age: 3 })).status).toBe(200);
    expect(reached()).toBe(1);
  });

  it('缺欄位、型別錯、超長 → 400 DATA_VALIDATION，handler 一次都沒被呼叫', async () => {
    const { app, reached } = validated();
    for (const bad of [{}, { name: 'a' }, { name: 'a', age: 'x' }, { name: 'x'.repeat(21), age: 1 }, { name: '', age: 1 }]) {
      const res = await post(app, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
    }
    expect(reached()).toBe(0);
  });

  it('不是 JSON 的 body → 400，不是 500', async () => {
    const { app, reached } = validated();
    const res = await post(app, '{not json');
    expect(res.status).toBe(400);
    expect(reached()).toBe(0);
  });

  it('驗證錯誤的 detail 只列欄位路徑，不回傳使用者送來的值（可能是密碼或 token）', async () => {
    const { app } = validated();
    const res = await post(app, { name: 'sk-live-secret-value'.repeat(3), age: 1 });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('name');
    expect(text).not.toContain('sk-live-secret-value');
  });
});
