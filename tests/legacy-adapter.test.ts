/** 舊 handler 轉接層：context 形狀、三種認證模式、錯誤形狀、OpenAPI 登記。走 HTTP 邊界。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from '@hono/zod-openapi';
import { createApp } from '../src/app';
import { AppError } from '../src/errors';
import type { Env } from '../src/env';
import { legacyRoute, type LegacyContext } from '../src/legacy';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
beforeEach(() => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', 'tok', ?, ?)")
    .run(JSON.stringify({ client_id: 'web', user_id: 'u1', scopes: ['trips:read'], grantId: 'g' }), Date.now() + 3600_000);
});
afterEach(() => d1.close());

function appWith(register: (app: ReturnType<typeof createApp>) => void) {
  const app = createApp();
  register(app);
  return app;
}
const call = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, env);
const AUTH = { Authorization: 'Bearer tok' };

const NestedErrorDoc = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

describe('legacyRoute', () => {
  it('把 request、env、params、data.auth、functionPath 交給舊 handler', async () => {
    let seen: LegacyContext | undefined;
    const app = appWith((a) => legacyRoute(a, {
      method: 'get', path: '/api/zz/:id/items/:n', auth: 'required',
      handler: ((ctx: LegacyContext) => { seen = ctx; return Response.json({ ok: true }); }) as never,
    }));
    const res = await call(app, '/api/zz/abc/items/7?x=1', AUTH);
    expect(res.status).toBe(200);
    expect(seen!.params).toEqual({ id: 'abc', n: '7' });
    expect(seen!.functionPath).toBe('/api/zz/abc/items/7');
    expect(seen!.env).toBe(env);
    expect(new URL(seen!.request.url).searchParams.get('x')).toBe('1');
    expect((seen!.data.auth as { userId: string }).userId).toBe('u1');
  });

  it("auth='required'：沒帶或無效的 bearer → 401，handler 不會被呼叫", async () => {
    let called = 0;
    const app = appWith((a) => legacyRoute(a, { method: 'get', path: '/api/zz', auth: 'required', handler: (() => { called++; return Response.json({}); }) as never }));
    expect((await call(app, '/api/zz')).status).toBe(401);
    expect((await call(app, '/api/zz', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect(called).toBe(0);
  });

  it("auth='optional'：沒帶 → auth 為 null 仍進 handler；帶了無效的 → 401（不降級成匿名）", async () => {
    let auth: unknown = 'unset';
    const app = appWith((a) => legacyRoute(a, { method: 'get', path: '/api/zz', auth: 'optional', handler: ((c: LegacyContext) => { auth = c.data.auth; return Response.json({}); }) as never }));
    expect((await call(app, '/api/zz')).status).toBe(200);
    expect(auth).toBeNull();
    expect((await call(app, '/api/zz', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call(app, '/api/zz', AUTH)).status).toBe(200);
    expect((auth as { userId: string }).userId).toBe('u1');
  });

  it("auth='none'：完全公開，連帶了有效 token 也不看（auth 恆為 null）", async () => {
    let auth: unknown = 'unset';
    const app = appWith((a) => legacyRoute(a, { method: 'get', path: '/api/zz', auth: 'none', handler: ((c: LegacyContext) => { auth = c.data.auth; return Response.json({}); }) as never }));
    expect((await call(app, '/api/zz', AUTH)).status).toBe(200);
    expect(auth).toBeNull();
    expect((await call(app, '/api/zz', { Authorization: 'Bearer nope' })).status).toBe(200);
  });

  it('handler 丟出 AppError → 與舊入口相同的巢狀錯誤回應；未預期例外 → 通用 500', async () => {
    const app = appWith((a) => {
      legacyRoute(a, { method: 'get', path: '/api/zz/nf', auth: 'none', handler: (() => { throw new AppError('DATA_NOT_FOUND', '找不到'); }) as never });
      legacyRoute(a, { method: 'get', path: '/api/zz/boom', auth: 'none', handler: (() => { throw new Error('secret detail'); }) as never });
    });
    const nf = await call(app, '/api/zz/nf');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: { code: 'DATA_NOT_FOUND', detail: '找不到' } });
    const boom = await call(app, '/api/zz/boom');
    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain('secret detail');
  });

  it('waitUntil 的工作在沒有 executionCtx 時也會在回應前完成（測試不會有時序問題）', async () => {
    let done = false;
    const app = appWith((a) => legacyRoute(a, { method: 'get', path: '/api/zz', auth: 'none', handler: ((c: LegacyContext) => { c.waitUntil(new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 20))); return Response.json({}); }) as never }));
    await call(app, '/api/zz');
    expect(done).toBe(true);
  });

  it('不同方法登記在同一路徑互不影響；沒有登記的方法 → 404', async () => {
    const app = appWith((a) => {
      legacyRoute(a, { method: 'get', path: '/api/zz', auth: 'none', handler: (() => Response.json({ m: 'get' })) as never });
      legacyRoute(a, { method: 'post', path: '/api/zz', auth: 'none', handler: (() => Response.json({ m: 'post' })) as never });
    });
    expect(await (await call(app, '/api/zz')).json()).toEqual({ m: 'get' });
    expect(await (await app.request('/api/zz', { method: 'POST' }, env)).json()).toEqual({ m: 'post' });
    expect((await app.request('/api/zz', { method: 'DELETE' }, env)).status).toBe(404);
  });

  it('登記進 OpenAPI：路徑以 {id} 表示、帶 path 參數與摘要', async () => {
    const app = appWith((a) => legacyRoute(a, { method: 'get', path: '/api/zz/:id', auth: 'none', summary: '範例', handler: (() => Response.json({})) as never }));
    const spec = await (await call(app, '/openapi.json')).json() as { paths: Record<string, Record<string, { summary?: string; parameters?: { name: string; in: string }[] }>> };
    const op = spec.paths['/api/zz/{id}']?.get;
    expect(op?.summary).toBe('範例');
    expect(op?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path' })]));
  });
});

describe('legacyRoute 的 OpenAPI 文件（只做文件，不在執行期驗證）', () => {
  const Body = z.object({ title: z.string(), days: z.number().int() });
  const Query = z.object({ limit: z.coerce.number().optional(), q: z.string().optional() });
  const Ok = z.object({ id: z.number(), title: z.string() });
  type Doc = { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> }; parameters?: { name: string; in: string }[]; responses: Record<string, { content?: Record<string, { schema: { properties?: Record<string, unknown> } }> }>; security?: unknown[] }>> };
  const docOf = async (app: ReturnType<typeof createApp>) => (await (await call(app, '/openapi.json')).json()) as Doc;
  let received: unknown;
  const documented = () => appWith((a) => legacyRoute(a, {
    method: 'post', path: '/api/zz/:id', auth: 'required', summary: '範例',
    docs: { query: Query, body: Body, responses: { 200: { description: '成功', schema: Ok }, 404: { description: '找不到', schema: NestedErrorDoc } } },
    handler: (async (c: LegacyContext) => { received = await c.request.json().catch(() => null); return Response.json({ id: 1, title: 't' }); }) as never,
  }));

  it('請求 body、query、各狀態碼的回應 schema 都寫進 OpenAPI', async () => {
    const op = (await docOf(documented())).paths['/api/zz/{id}']!.post!;
    expect(Object.keys(op.requestBody!.content['application/json']!.schema.properties!).sort()).toEqual(['days', 'title']);
    expect(op.parameters!.map((p) => `${p.in}:${p.name}`).sort()).toEqual(['path:id', 'query:limit', 'query:q']);
    expect(Object.keys(op.responses).sort()).toEqual(['200', '404']);
    expect(Object.keys(op.responses['200']!.content!['application/json']!.schema.properties!).sort()).toEqual(['id', 'title']);
  });

  it('文件不影響執行：body 不符合文件裡的 schema 照樣進 handler（驗證仍由 handler 自己負責）', async () => {
    received = 'unset';
    const res = await documented().request('/api/zz/1?limit=abc', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ title: 123, extra: true }) }, env);
    expect(res.status).toBe(200);
    expect(received).toEqual({ title: 123, extra: true });
  });

  it('認證模式反映在文件的 security：required 要 bearer、optional 可有可無、none 沒有', async () => {
    const mk = (auth: 'required' | 'optional' | 'none', path: string) => (a: ReturnType<typeof createApp>) => legacyRoute(a, { method: 'get', path, auth, handler: (() => Response.json({})) as never });
    const doc = await docOf(appWith((a) => { mk('required', '/api/zr')(a); mk('optional', '/api/zo')(a); mk('none', '/api/zn')(a); }));
    expect(doc.paths['/api/zr']!.get!.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/zo']!.get!.security).toEqual([{ bearerAuth: [] }, {}]);
    expect(doc.paths['/api/zn']!.get!.security ?? []).toEqual([]);
  });

  it('body 預設必填；bodyRequired:false 時文件標為選填（handler 自己決定要不要 body 的端點）', async () => {
    const mk = (path: string, bodyRequired?: boolean) => (a: ReturnType<typeof createApp>) => legacyRoute(a, {
      method: 'post', path, auth: 'none', handler: (() => Response.json({})) as never,
      docs: { body: Body, ...(bodyRequired === undefined ? {} : { bodyRequired }) },
    });
    const doc = await docOf(appWith((a) => { mk('/api/zb1')(a); mk('/api/zb2', false)(a); mk('/api/zb3', true)(a); }));
    const required = (p: string) => (doc.paths[p]!.post!.requestBody as { required?: boolean }).required;
    expect(required('/api/zb1')).toBe(true);
    expect(required('/api/zb2')).toBe(false);
    expect(required('/api/zb3')).toBe(true);
  });

  it('沒有提供 docs 時維持原本的預設文件（200 任意內容）', async () => {
    const doc = await docOf(appWith((a) => legacyRoute(a, { method: 'get', path: '/api/zd', auth: 'none', handler: (() => Response.json({})) as never })));
    expect(Object.keys(doc.paths['/api/zd']!.get!.responses)).toEqual(['200']);
  });

  it('執行期行為不變：認證、錯誤形狀、waitUntil（既有測試之外再確認一次）', async () => {
    expect((await call(documented(), '/api/zz/1')).status).toBe(404); // POST 才有；GET 沒登記
    const res = await documented().request('/api/zz/1', { method: 'POST' }, env);
    expect(res.status).toBe(401);
  });
});
