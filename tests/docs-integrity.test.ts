/** OpenAPI 文件與實際行為的整體一致性（T19 產生 client 的依據）。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
const app = createApp();
beforeEach(() => { d1 = createD1(); env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env; });
afterEach(() => d1.close());

type Op = { security?: unknown[]; requestBody?: { required?: boolean } };
const spec = async () => (await (await app.request('/openapi.json', {}, env)).json()) as { paths: Record<string, Record<string, Op>> };

describe('一律要登入的 GET 不可標成可匿名', () => {
  const PATHS = ['/api/trips/{id}/audit', '/api/trips/{id}/health-check', '/api/trips/{id}/health'];
  it('文件的 security 是必須帶 bearer', async () => {
    const s = await spec();
    for (const p of PATHS) expect(s.paths[p]!.get!.security, p).toEqual([{ bearerAuth: [] }]);
  });
  it('匿名實際得到 401（文件與行為一致）', async () => {
    for (const p of PATHS) {
      const res = await app.request(p.replace('{id}', 't1'), {}, env);
      expect(res.status, p).toBe(401);
    }
  });
});

describe('body 為選填的端點', () => {
  it('POST /api/admin/maps-lock 的 body 在文件裡是選填（handler 沒有 body 也能執行）', async () => {
    const s = await spec();
    expect(s.paths['/api/admin/maps-lock']!.post!.requestBody?.required).toBe(false);
  });
});

describe('每條路由都有認證模式一致的文件', () => {
  it('需要登入的路由（required）一律有 bearer security；公開的（none）沒有', async () => {
    const s = await spec();
    const publicPaths = ['/api/health', '/openapi.json', '/api/public-config', '/api/oauth/token', '/api/oauth/login'];
    for (const p of publicPaths) for (const op of Object.values(s.paths[p] ?? {})) expect(op.security ?? [], p).toEqual([]);
    for (const p of ['/api/my-trips', '/api/account', '/api/trips/{id}/days']) {
      const ops = Object.values(s.paths[p] ?? {});
      expect(ops.length, p).toBeGreaterThan(0);
      for (const op of ops) expect(op.security?.length ?? 0, p).toBeGreaterThan(0);
    }
  });
});
