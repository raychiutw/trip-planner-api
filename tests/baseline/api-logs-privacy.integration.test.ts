/**
 * api_logs 中介層的隱私與過濾規則（新增測試）。
 * 不可記錄 Authorization、query 裡的 ticket、request／response body；匿名 4xx 不寫（bot 雜訊）；已驗證身分的 4xx 與任何 5xx 要寫。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});
afterAll(disposeMiniflare);

const rowsFor = async (path: string) =>
  (await db.prepare('SELECT * FROM api_logs WHERE path = ?').bind(path).all<Record<string, unknown>>()).results;

describe('api_logs 隱私', () => {
  it('已驗證身分的 4xx 會寫；整列都不含 token、ticket、body 內容', async () => {
    const token = await serviceToken(db, ['ops:poi']);
    const res = await api.request('POST', '/api/admin/maps-lock?ticket=TICKET-SECRET-123', {
      bearer: token,
      json: { reason: 'BODY-SECRET-456' },
    });
    expect(res.status).toBe(403); // scope 不符

    const rows = await rowsFor('/api/admin/maps-lock');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'POST', status: 403, source: 'service_token' });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain('TICKET-SECRET-123');
    expect(dump).not.toContain('BODY-SECRET-456');
    expect(dump).not.toContain('ticket=');
  });

  it('匿名 4xx 不寫 log（bot 雜訊）', async () => {
    const res = await api.get('/api/admin/maps-settings?probe=1');
    expect(res.status).toBe(401);
    expect(await rowsFor('/api/admin/maps-settings')).toHaveLength(0);
  });

  it('2xx 不寫 log', async () => {
    const token = await serviceToken(db, ['ops:maps']);
    expect((await api.request('GET', '/api/admin/maps-settings', { bearer: token })).status).toBe(200);
    expect(await rowsFor('/api/admin/maps-settings')).toHaveLength(0);
  });

  it('5xx（未預期例外）一律寫（含 error 欄），回應仍是通用訊息、不洩漏細節', async () => {
    // 只讓 pois 查詢丟錯（token 驗證與 api_logs 寫入走真 DB），逼 handler 產生未預期例外 → 500
    const flaky = {
      prepare: (sql: string) => {
        if (/FROM pois/.test(sql)) throw new Error('SECRET-DB-DETAIL');
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const flakyApi = createApi({ env: mockEnv(db, { DB: flaky }) });
    const token = await serviceToken(db, ['ops:poi']);
    const res = await flakyApi.request('GET', '/api/admin/pois-pending-place-id', { bearer: token });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('SECRET-DB-DETAIL');

    const rows = await rowsFor('/api/admin/pois-pending-place-id');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 500, source: 'service_token' });
    expect(String(rows[0]!.error)).toContain('SECRET-DB-DETAIL'); // 內部診斷資訊只進 api_logs，不進回應
  });
});
