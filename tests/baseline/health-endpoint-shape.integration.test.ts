/**
 * GET /api/health — 回應形狀鎖。
 *
 * 為什麼要真的呼叫而不是 source-grep：tests/unit/api-health-endpoint.test.ts 只對
 * 原始碼做 regex 比對，所以它看不出「JSDoc 宣稱的欄位」與「實際回傳的欄位」有沒有
 * 對上。結果就是 JSDoc 從 v2.33.126 起宣稱回應帶 `version: VITE_BUILD_VERSION?`，
 * 而該識別字全 repo 只存在於那行註解本身 —— 兩個月、數次 release 都沒人發現。
 *
 * 這裡精確比對 key 集合：往回應加欄位而沒同步文件會讓這條紅。反方向（往 JSDoc 寫
 * 一個沒實作的欄位，也就是 version 當初的走法）擋不住 —— 本檔只讀 runtime，讀不到
 * 註解。要擋那個方向得去解析 health.ts 的 docblock，那是另一條測試。
 * 這是這個 endpoint 唯一會真的執行 handler 的測試。
 * 走 HTTP 邊界（tests/api/http.ts）：公開端點，不需認證；D1 故障用會拋錯的 DB 注入 env。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import type { Env } from '../../src/env';

/**
 * D1 outage：每個 query 都 reject —— checkD1 的 catch 看到的就是這個。
 * 和真實 D1 一致：prepare/bind 本身不拋，執行時才失敗；
 * middleware 寫 api_logs 的 waitUntil 也會 reject，但不影響回應。
 */
const failingStatement = {
  bind: () => failingStatement,
  first: () => Promise.reject(new Error('D1_ERROR: Network connection lost')),
  run: () => Promise.reject(new Error('D1_ERROR: Network connection lost')),
  all: () => Promise.reject(new Error('D1_ERROR: Network connection lost')),
};
const throwingDb = { prepare: () => failingStatement } as unknown as D1Database;

/** D1 回得來但形狀不對（row 存在、沒有 ok=1）—— 走 checkD1 不拋的那條 fail。 */
const emptyStatement = {
  bind: () => emptyStatement,
  first: async () => null,
  run: async () => ({ success: true, meta: { changes: 0 } }),
  all: async () => ({ results: [] }),
};
const wrongShapeDb = { prepare: () => emptyStatement } as unknown as D1Database;

describe('GET /api/health — 回應形狀', () => {
  let db: D1Database;

  beforeAll(async () => {
    db = await createTestDb();
  }, 30000);

  afterAll(disposeMiniflare);

  const call = async (overrides: Partial<Env> = {}) => {
    const env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'x'.repeat(20), ...overrides });
    const resp = await createApi({ env }).get('/api/health');
    return { resp, body: (await resp.json()) as Record<string, unknown> };
  };

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

  // 這個 endpoint 的存在意義就是 D1 掛掉時讓 uptime monitor 轉紅。在本檔誕生前，
  // 唯一「蓋到」503 的是 api-health-endpoint.test.ts:31 的一條 source regex
  // （比對 `status = 'unhealthy'; httpStatus = 503;` 這段字面原始碼）—— 它證明不了
  // handler 真的回 503，重排一下那兩行就能騙過它。這裡真的把 handler 跑起來。
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
    // if/else if 的順序：D1 fail 先判。若有人把兩個分支對調，兩邊都壞時會回
    // degraded + 200，uptime monitor 在資料庫全掛的情況下維持綠燈。
    const { resp, body } = await call({ DB: throwingDb, GOOGLE_MAPS_API_KEY: '' });
    expect(resp.status).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  it('ts 是可解析的 ISO timestamp', async () => {
    const { body } = await call();
    expect(Number.isNaN(Date.parse(body.ts as string))).toBe(false);
  });
});
