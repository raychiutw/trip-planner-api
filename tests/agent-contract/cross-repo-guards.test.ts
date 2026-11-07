/**
 * agent issue #5 第 3、4、5 項：agent 的假設必須對得上 api 實際的行為。
 *   3. daily-check 的 api_logs 排除字串 ↔ api 真的寫進 api_logs.error 的組字（AppError → `${code}: ${detail}`）
 *   4. maps-settings 與 app_settings 不再出現三個幽靈預算 key
 *   5. agent worker 最長執行時間（快照 limits）< REQUEST_STALE_MINUTES
 * 第 3、4 項的「web 側」（舊入口）不在本 repo，無法在此守；此處守的是 api 這一側。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv } from '../baseline/helpers';
import { createApi } from '../baseline/http';
import { serviceToken } from '../baseline/service-token';
import { _resetGcpTokenCacheForTest } from '../../src/lib/gcp-monitoring';
import { REQUEST_STALE_MINUTES } from '../../src/lib/request-termination';
import { contract, sqlOf } from './helpers';

let db: D1Database;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { vi.unstubAllGlobals(); await disposeMiniflare(); });

describe('第 3 項：daily-check 排除字串 ↔ api 實際寫入的 api_logs.error', () => {
  it('quota-estimate 在 GCP 不可用時寫入的那一筆，會被 apiErrors SQL 排除', async () => {
    _resetGcpTokenCacheForTest();
    // 沒設 GCP 憑證 → handler 直接 throw AppError(MAPS_UPSTREAM_FAILED, 詳情)，不打外部
    const api = createApi({ env: mockEnv(db) });
    const token = await serviceToken(db, ['ops:maps'], 'agent-contract-quota');
    expect((await api.get('/api/admin/quota-estimate', { bearer: token })).status).toBe(502);

    const row = await db.prepare("SELECT path, status, error FROM api_logs WHERE path = '/api/admin/quota-estimate'").first<{ error: string }>();
    expect(row, 'api 沒寫 api_logs').toBeTruthy();
    // 真實資料列放進 apiErrors 的 24h 視窗後，必須被扣掉（total 為 0 = 不重報）
    const sql = sqlOf('apiErrors', 0);
    const hits = (await db.prepare(sql).all<{ path: string; count: number }>()).results.filter((r) => r.path === '/api/admin/quota-estimate');
    expect(hits, `排除字串與 api 寫入的 error 不一致，實際為：${row?.error}`).toEqual([]);
  });

  it('/api/route 的「Routes empty result」排除字串仍是 api 會丟出的訊息', async () => {
    const m = sqlOf('apiErrors', 0).match(/path = '\/api\/route' AND error = '([^']+)'/);
    expect(m, '快照的 apiErrors SQL 找不到 /api/route 排除條件').toBeTruthy();
    const src = readFileSync(join(__dirname, '../../src/lib/maps/google-client.ts'), 'utf8');
    expect(src).toContain(`fail('${m![1]!.replace('MAPS_UPSTREAM_FAILED: ', '')}')`);
  });
});

describe('第 4 項：幽靈預算 key 不得回來', () => {
  const PHANTOM = ['budget_usd', 'lock_threshold_pct', 'unlock_threshold_pct'];

  it('maps-settings 回應只有鎖定狀態三欄', async () => {
    const api = createApi({ env: mockEnv(db) });
    const token = await serviceToken(db, ['ops:maps'], 'agent-contract-maps');
    const res = await api.get('/api/admin/maps-settings', { bearer: token });
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['is_locked', 'locked_at', 'locked_reason']);
  });

  it('套完 migrations 的 app_settings 沒有任何 *_budget_usd／*_threshold_pct key', async () => {
    const keys = (await db.prepare('SELECT key FROM app_settings').all<{ key: string }>()).results.map((r) => r.key);
    expect(keys.filter((k) => PHANTOM.some((p) => k.endsWith(p)))).toEqual([]);
  });

  it('agent 的 daily-check SQL 不查幽靈 key', () => {
    const all = contract.dailyCheckSql.flatMap((s) => s.sql).join('\n');
    for (const p of PHANTOM) expect(all).not.toContain(p);
  });
});

describe('第 5 項：worker 逾時 < REQUEST_STALE_MINUTES', () => {
  it('快照 limits.requestWorkerMaxMinutes 小於 api 判定逾時的門檻', () => {
    const w = contract.limits?.requestWorkerMaxMinutes;
    expect(typeof w, '快照缺 limits.requestWorkerMaxMinutes：請在 agent 重跑 export:contract').toBe('number');
    expect(w!, `worker ${w} 分鐘必須 < api 的 REQUEST_STALE_MINUTES ${REQUEST_STALE_MINUTES}`).toBeLessThan(REQUEST_STALE_MINUTES);
  });
});
