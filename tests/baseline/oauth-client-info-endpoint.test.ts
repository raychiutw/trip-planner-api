/**
 * GET /api/oauth/client-info?client_id=<id> — Phase 2：consent 畫面用的公開 app 品牌資訊。
 * 走 HTTP 邊界（tests/api/http.ts），client_apps 是真實 D1 資料列。
 *
 * ConsentPage 在使用者按「允許」前呼叫，顯示「哪個 app 要用我的帳號」（app_name / logo /
 * description / homepage）。鎖住不變式：
 *   - active client → 回 app_name/app_description/app_logo_url/homepage_url（snake_case，rawJson）
 *   - 缺 client_id → DATA_VALIDATION（400）
 *   - 未註冊 / 非 active → DATA_NOT_FOUND（404），不洩漏 suspended/pending app 名稱
 *   - 只回公開品牌欄位（絕不回 client_secret）；只回 status='active'
 *
 * 原本用 mock DB 擷取 SQL 字串與 bind 參數；改成讀真實行為：
 *   - 「SQL 帶 status=active 過濾」→ suspended / pending_review 的 client 回 404
 *   - 「SQL 不 SELECT client_secret」→ 資料列真的有 client_secret_hash，回應仍不含任何機密欄位
 *   - 「bind 的是該 client_id」→ 兩個 active client 並存時，只回被查詢的那一個
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';

// 共用 D1：本檔專用的 client_id 前綴
const ACTIVE = 'cie-active-app';
const OTHER_ACTIVE = 'cie-other-active-app';
const SUSPENDED = 'cie-suspended-app';
const PENDING = 'cie-pending-app';
const CLIENTS = [ACTIVE, OTHER_ACTIVE, SUSPENDED, PENDING];

const ACTIVE_ROW = {
  app_name: 'Tripline 行程助理',
  app_description: '幫你把行程排進去',
  app_logo_url: null,
  homepage_url: 'https://trip-planner-dby.pages.dev',
};

let db: D1Database;
let api: Api;

async function seedClient(
  clientId: string,
  status: 'active' | 'suspended' | 'pending_review',
  fields: { app_name: string; app_description?: string | null; app_logo_url?: string | null; homepage_url?: string | null },
) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO client_apps
         (client_id, client_secret_hash, client_type, app_name, app_description, app_logo_url, homepage_url,
          redirect_uris, allowed_scopes, status)
       VALUES (?, 'pbkdf2$secret-hash-must-not-leak', 'confidential', ?, ?, ?, ?, '["https://x.test/cb"]', '["openid"]', ?)`,
    )
    .bind(clientId, fields.app_name, fields.app_description ?? null, fields.app_logo_url ?? null, fields.homepage_url ?? null, status)
    .run();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedClient(ACTIVE, 'active', ACTIVE_ROW);
  await seedClient(OTHER_ACTIVE, 'active', { app_name: '另一個 App', app_description: 'other', homepage_url: 'https://other.test' });
  await seedClient(SUSPENDED, 'suspended', { app_name: '停用中的 App' });
  await seedClient(PENDING, 'pending_review', { app_name: '待審的 App' });
}, 30000);

afterAll(async () => {
  for (const id of CLIENTS) await db.prepare('DELETE FROM client_apps WHERE client_id = ?').bind(id).run();
  await disposeMiniflare();
});

const info = (clientId: string | null) =>
  api.get(clientId === null ? '/api/oauth/client-info' : `/api/oauth/client-info?client_id=${encodeURIComponent(clientId)}`);

describe('GET /api/oauth/client-info', () => {
  it('active client → 200 + 公開品牌欄位（snake_case，非 camelCase）', async () => {
    const res = await info(ACTIVE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(ACTIVE_ROW);
    // rawJson 不 deepCamel：ConsentPage 的 ClientAppInfo 用 snake_case，appName 會壞掉。
    expect(body).not.toHaveProperty('appName');
    // 絕不外洩機密。
    expect(body).not.toHaveProperty('client_secret');
  });

  it('只回被查詢的 active client、不回機密；suspended / pending_review 不回（形式改變：原為 SQL 字串斷言）', async () => {
    // client_id 綁定：兩個 active client 並存，回的是被查的那一個
    const other = (await (await info(OTHER_ACTIVE)).json()) as Record<string, unknown>;
    expect(other.app_name).toBe('另一個 App');
    // 資料列有 client_secret_hash，回應整段文字都不含任何機密
    const raw = await (await info(ACTIVE)).text();
    expect(raw).not.toMatch(/client_secret|secret-hash|pbkdf2/i);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['app_description', 'app_logo_url', 'app_name', 'homepage_url']);
    // status='active' 過濾：非 active 的 client 一律 404，不洩漏名稱
    for (const id of [SUSPENDED, PENDING]) {
      const res = await info(id);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/停用中|待審/);
    }
  });

  it('缺 client_id → DATA_VALIDATION（400）', async () => {
    const res = await info(null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DATA_VALIDATION');
  });

  it('未註冊 / 非 active → DATA_NOT_FOUND（404，保留 ConsentPage 保底顯示）', async () => {
    const res = await info('cie-ghost-client');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DATA_NOT_FOUND');
    // 非 active 同樣是 DATA_NOT_FOUND（不是別的碼）
    const suspended = await info(SUSPENDED);
    expect(((await suspended.json()) as { error: { code: string } }).error.code).toBe('DATA_NOT_FOUND');
  });

  it('client_id 前後空白會 trim', async () => {
    const res = await info(`  ${ACTIVE}  `);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ACTIVE_ROW);
  });
});
