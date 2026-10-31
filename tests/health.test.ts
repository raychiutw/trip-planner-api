/**
 * GET /api/health 的 HTTP 邊界測試。
 *
 * 這些案例從舊入口（trip-planner 的 tests/api/health-endpoint-shape）原樣搬來，
 * 是基準測試的第一批：同一份行為，舊入口與新 api 都要通過。
 * 進程內以 app.request 發 Request、拿 Response；env 由測試注入（D1 故障用會拋錯的 DB）。
 */
import { describe, it, expect } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';

/** D1 outage：每個 query 都 reject；prepare／bind 本身不拋，執行時才失敗（與真實 D1 一致）。 */
const failingStatement = {
  bind: () => failingStatement,
  first: () => Promise.reject(new Error('D1_ERROR: Network connection lost')),
};
const throwingDb = { prepare: () => failingStatement } as unknown as D1Database;

/** D1 回得來但形狀不對（row 存在、沒有 ok=1）—— 走 checkD1 不拋的那條 fail。 */
const emptyStatement = { bind: () => emptyStatement, first: async () => null };
const wrongShapeDb = { prepare: () => emptyStatement } as unknown as D1Database;

const okStatement = { bind: () => okStatement, first: async () => ({ ok: 1 }) };
const okDb = { prepare: () => okStatement } as unknown as D1Database;

async function call(overrides: Partial<Env> = {}) {
  const env = { DB: okDb, GOOGLE_MAPS_API_KEY: 'x'.repeat(20), ...overrides } as Env;
  const resp = await app.request('/api/health', {}, env);
  return { resp, body: (await resp.json()) as Record<string, unknown> };
}

describe('GET /api/health — 回應形狀', () => {
  it('回應的 key 集合就是 status / checks / ts —— 沒有 version，沒有別的', async () => {
    const { body } = await call();
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'ts']);
    expect(Object.keys(body.checks as object).sort()).toEqual(['d1', 'googleMapsKey']);
  });

  it('全 ok → healthy + 200', async () => {
    const { resp, body } = await call();
    expect(resp.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks).toEqual({ d1: 'ok', googleMapsKey: 'ok' });
  });

  it('缺 Google Maps key → degraded + 200（非關鍵，仍 serve 非 Maps 流量）', async () => {
    const { resp, body } = await call({ GOOGLE_MAPS_API_KEY: '' });
    expect(resp.status).toBe(200);
    expect(body.status).toBe('degraded');
  });

  it('D1 拋錯 → unhealthy + 503（monitor 必須看到紅燈）', async () => {
    const { resp, body } = await call({ DB: throwingDb });
    expect(resp.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.checks).toEqual({ d1: 'fail', googleMapsKey: 'ok' });
  });

  it('D1 回得來但不是 ok=1（不拋）→ 一樣 unhealthy + 503', async () => {
    const { resp, body } = await call({ DB: wrongShapeDb });
    expect(resp.status).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  it('D1 掛 + key 也缺 → unhealthy 503，不是 degraded 200', async () => {
    const { resp, body } = await call({ DB: throwingDb, GOOGLE_MAPS_API_KEY: '' });
    expect(resp.status).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  it('503 的回應形狀與 200 相同（key 集合一致）', async () => {
    const { body } = await call({ DB: throwingDb });
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'ts']);
    expect(Object.keys(body.checks as object).sort()).toEqual(['d1', 'googleMapsKey']);
  });

  it('Google Maps key 長度要大於 10：10 個字元算缺，11 個才算 ok', async () => {
    expect((await call({ GOOGLE_MAPS_API_KEY: 'x'.repeat(10) })).body.checks).toEqual({ d1: 'ok', googleMapsKey: 'missing' });
    expect((await call({ GOOGLE_MAPS_API_KEY: 'x'.repeat(11) })).body.checks).toEqual({ d1: 'ok', googleMapsKey: 'ok' });
  });

  it('ts 是可解析的 ISO timestamp', async () => {
    const { body } = await call();
    expect(Number.isNaN(Date.parse(body.ts as string))).toBe(false);
  });
});

describe('OpenAPI 契約', () => {
  it('GET /openapi.json 由 schema 產出，且描述 /api/health', async () => {
    const resp = await app.request('/openapi.json', {}, { DB: okDb } as Env);
    expect(resp.status).toBe(200);
    const doc = (await resp.json()) as {
      openapi: string;
      paths: Record<string, { get?: { responses: Record<string, unknown> } }>;
    };
    expect(doc.openapi).toMatch(/^3\./);
    const responses = doc.paths['/api/health']?.get?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual(['200', '503']);
  });
});
