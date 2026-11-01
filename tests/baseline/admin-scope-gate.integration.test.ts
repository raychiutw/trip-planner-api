/**
 * /api/admin/* 全部端點的 ops scope gate（新增測試，補舊測試只蓋到 maps-settings／backfill-status／quota-estimate 的缺口）。
 *
 * 每個端點：匿名 → 401；一般使用者（即使 token 自帶 ops scope）→ 403；service token 但 scope 不符 → 403；
 * scope 正確 → 2xx。沒有全域 admin，任何人都不能靠 email／trip 角色通過。
 * Google／GCP 呼叫一律以 stub 取代：這個檔案裡任何對外 fetch 都會直接丟錯（不可真的連線）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    throw new Error(`測試中不可對外連線：${String(input)}`);
  });
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeMiniflare();
});

const ENDPOINTS: Array<{ method: string; path: string; scope: string; okStatus?: number }> = [
  { method: 'GET', path: '/api/admin/maps-settings', scope: 'ops:maps', okStatus: 200 },
  { method: 'POST', path: '/api/admin/maps-lock', scope: 'ops:maps', okStatus: 200 },
  { method: 'POST', path: '/api/admin/maps-unlock', scope: 'ops:maps', okStatus: 200 },
  { method: 'GET', path: '/api/admin/quota-estimate', scope: 'ops:maps' }, // 200 路徑需 GCP stub，見 quota-estimate-gcp.test.ts
  { method: 'GET', path: '/api/admin/backfill-status', scope: 'ops:poi', okStatus: 200 },
  { method: 'GET', path: '/api/admin/pois-due-refresh', scope: 'ops:poi', okStatus: 200 },
  { method: 'GET', path: '/api/admin/pois-pending-place-id', scope: 'ops:poi', okStatus: 200 },
  { method: 'POST', path: '/api/admin/cache-cleanup', scope: 'ops:cache', okStatus: 200 },
];

const otherScope = (scope: string) => (scope === 'ops:poi' ? 'ops:cache' : 'ops:poi');

describe.each(ENDPOINTS)('$method $path（$scope）', ({ method, path, scope, okStatus }) => {
  it('匿名 → 401', async () => {
    expect((await api.request(method, path)).status).toBe(401);
  });

  it('一般使用者 → 403，即使 token 自帶同名 scope（無偽造路徑）', async () => {
    expect((await api.request(method, path, { as: 'plain-user@test.com' })).status).toBe(403);
    expect((await api.request(method, path, { as: 'plain-user@test.com', scopes: [scope] })).status).toBe(403);
  });

  it('service token 但 scope 不符 → 403；舊 admin scope 不算', async () => {
    const wrong = await serviceToken(db, [otherScope(scope)]);
    expect((await api.request(method, path, { bearer: wrong })).status).toBe(403);
    const legacyAdmin = await serviceToken(db, ['admin']);
    expect((await api.request(method, path, { bearer: legacyAdmin })).status).toBe(403);
  });

  if (okStatus) {
    it('scope 正確 → 通過', async () => {
      const ok = await serviceToken(db, [scope]);
      expect((await api.request(method, path, { bearer: ok })).status).toBe(okStatus);
    });
  }
});

describe('maps-lock／maps-unlock 的狀態效果', () => {
  it('lock 寫入鎖定狀態並留 audit；unlock 解除', async () => {
    const token = await serviceToken(db, ['ops:maps'], 'ops-maps-cli');
    const lock = await api.request('POST', '/api/admin/maps-lock', { bearer: token, json: { reason: 'quota 告警' } });
    expect(lock.status).toBe(200);
    expect(((await lock.json()) as { locked: boolean }).locked).toBe(true);
    const audit = await db.prepare("SELECT changed_by FROM audit_log WHERE table_name = 'app_settings' ORDER BY id DESC LIMIT 1").first<{ changed_by: string }>();
    expect(audit?.changed_by).toBe('service:ops-maps-cli'); // 不繼承任何 email

    const unlock = await api.request('POST', '/api/admin/maps-unlock', { bearer: token });
    expect(unlock.status).toBe(200);
    expect(((await unlock.json()) as { locked: boolean }).locked).toBe(false);
  });
});
