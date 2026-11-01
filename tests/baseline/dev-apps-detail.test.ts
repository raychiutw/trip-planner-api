/**
 * /api/dev/apps/:client_id — V2-P4 detail / update / suspend
 * 走 HTTP 邊界（tests/api/http.ts）：session 是真實簽出的 cookie + session_devices 資料列；
 * 原本檢查 SQL 字串與 bind 參數的斷言，改讀真實 D1 的 client_apps 資料變化。
 * 共用 D1：專用 id／email（s16-dd-），結束時清掉自己的資料。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';

const SESSION_SECRET = 'test-secret-32-chars-long-enough';
const U1 = 's16-dd-user-1';
const U2 = 's16-dd-user-2';
const EMAIL1 = 's16-dd-user-1@example.com';
const EMAIL2 = 's16-dd-user-2@example.com';
const APP = 's16-dd-tp_abc';
const APP_OF_U2 = 's16-dd-tp_other';

let db: D1Database;
let api: Api;
let cookie1: string;

type AppRow = {
  client_id: string; client_type: string; app_name: string; app_description: string | null;
  homepage_url: string | null; redirect_uris: string; allowed_scopes: string; owner_user_id: string | null;
  status: string; updated_at: string;
};
const appRow = (clientId: string) =>
  db.prepare('SELECT * FROM client_apps WHERE client_id = ?').bind(clientId).first<AppRow>();

async function seed(clientId: string, ownerId: string) {
  await db.prepare(
    `INSERT INTO client_apps (client_id, client_type, app_name, app_description, homepage_url, redirect_uris, allowed_scopes, owner_user_id, status, created_at, updated_at)
     VALUES (?, 'public', 'Trip Buddy', 'Travel companion', 'https://example.com', '["https://example.com/cb"]', '["openid","profile"]', ?, 'active', '2026-04-20', '2026-04-22')`,
  ).bind(clientId, ownerId).run();
}

async function cleanup() {
  await db.prepare('DELETE FROM client_apps WHERE client_id LIKE ?').bind('s16-dd-%').run();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET }) });
  cookie1 = (await sessionFor(db, EMAIL1, U1)).bearer;
  await sessionFor(db, EMAIL2, U2);
}, 30000);

beforeEach(async () => {
  await cleanup();
  await seed(APP, U1);
  await seed(APP_OF_U2, U2);
});

afterAll(async () => {
  await cleanup();
  await db.prepare('DELETE FROM session_devices WHERE user_id IN (?, ?)').bind(U1, U2).run();
  await db.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(U1, U2).run();
  await disposeMiniflare();
});

describe('GET /api/dev/apps/:client_id', () => {
  it('401 when no session', async () => {
    const res = await api.get(`/api/dev/apps/${APP}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('404 APP_NOT_FOUND when client_id not owned by user', async () => {
    const res = await api.get('/api/dev/apps/s16-dd-tp_xyz', { bearer: cookie1 });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('APP_NOT_FOUND');
  });

  it('200 returns full row with parsed redirect_uris + allowed_scopes', async () => {
    const res = await api.get(`/api/dev/apps/${APP}`, { bearer: cookie1 });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.client_id).toBe(APP);
    expect(json.app_name).toBe('Trip Buddy');
    expect(json.redirect_uris).toEqual(['https://example.com/cb']);
    expect(json.allowed_scopes).toEqual(['openid', 'profile']);
    expect(json).not.toHaveProperty('client_secret_hash');
  });

  // 原本斷言 SQL 含 `client_id = ? AND owner_user_id = ?`；改成直接驗行為：別人的 app 讀不到
  it('cross-user attack defence：讀別人擁有的 client_id → 404，不洩漏內容', async () => {
    const res = await api.get(`/api/dev/apps/${APP_OF_U2}`, { bearer: cookie1 });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('Trip Buddy');
  });
});

describe('PATCH /api/dev/apps/:client_id', () => {
  it('401 when no session', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, {  json: {} });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('404 when client_id not owned', async () => {
    const res = await api.request('PATCH', '/api/dev/apps/s16-dd-tp_xyz', { bearer: cookie1, json: { app_name: 'New Name' } });
    expect(res.status).toBe(404);
  });

  it('cross-user：改別人擁有的 client_id → 404，資料不變', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP_OF_U2}`, { bearer: cookie1, json: { app_name: 'Hijacked' } });
    expect(res.status).toBe(404);
    expect((await appRow(APP_OF_U2))?.app_name).toBe('Trip Buddy');
  });

  it('400 when no patchable fields provided', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, { bearer: cookie1, json: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
  });

  it('400 when app_name too short', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, { bearer: cookie1, json: { app_name: 'X' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
    expect((await appRow(APP))?.app_name).toBe('Trip Buddy');
  });

  it('400 when redirect_uris contains non-HTTPS', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, { bearer: cookie1, json: { redirect_uris: ['http://attacker.com/cb'] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
    expect((await appRow(APP))?.redirect_uris).toBe('["https://example.com/cb"]');
  });

  it('200 updates allowed fields + returns updated row', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, {
      bearer: cookie1, json: { app_name: 'New Name', app_description: 'Updated description' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.app_name).toBe('New Name');
    expect(json.app_description).toBe('Updated description');

    // Verify the row was really updated (and updated_at bumped)
    const row = await appRow(APP);
    expect(row).toMatchObject({ app_name: 'New Name', app_description: 'Updated description' });
    expect(row!.updated_at).not.toBe('2026-04-22');
  });

  it('Cannot update protected fields (client_id / client_type / status / owner_user_id)', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, {
      bearer: cookie1,
      json: {
        app_name: 'New',
        client_id: 'malicious',          // ignored
        client_type: 'confidential',      // ignored
        status: 'pending_review',         // ignored
        owner_user_id: 'attacker',        // ignored
      },
    });
    expect(res.status).toBe(200);
    const row = await appRow(APP);
    expect(row).toMatchObject({ app_name: 'New', client_id: APP, client_type: 'public', status: 'active', owner_user_id: U1 });
    expect(await appRow('malicious')).toBeNull();
  });

  // mutation 驗證補的缺口：維運 scope 不得經 PATCH 提權
  it.each(['companion', 'ops:maps'])('allowed_scopes 含 %s → 400，scope 不變', async (scope) => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, { bearer: cookie1, json: { allowed_scopes: ['openid', scope] } });
    expect(res.status).toBe(400);
    expect((await appRow(APP))?.allowed_scopes).toBe('["openid","profile"]');
  });

  it('allowed_scopes 空陣列 → 400（不退回預設值）', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, { bearer: cookie1, json: { allowed_scopes: [] } });
    expect(res.status).toBe(400);
    expect((await appRow(APP))?.allowed_scopes).toBe('["openid","profile"]');
  });

  it('homepage_url 非 https → 400，資料不變', async () => {
    const res = await api.request('PATCH', `/api/dev/apps/${APP}`, { bearer: cookie1, json: { homepage_url: 'javascript:alert(1)' } });
    expect(res.status).toBe(400);
    expect((await appRow(APP))?.homepage_url).toBe('https://example.com');
  });
});

describe('DELETE /api/dev/apps/:client_id', () => {
  it('401 when no session', async () => {
    const res = await api.request('DELETE', `/api/dev/apps/${APP}`, {  });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('404 when client_id not owned', async () => {
    const res = await api.request('DELETE', '/api/dev/apps/s16-dd-tp_xyz', { bearer: cookie1 });
    expect(res.status).toBe(404);
  });

  it('cross-user：停用別人擁有的 client_id → 404，狀態不變', async () => {
    const res = await api.request('DELETE', `/api/dev/apps/${APP_OF_U2}`, { bearer: cookie1 });
    expect(res.status).toBe(404);
    expect((await appRow(APP_OF_U2))?.status).toBe('active');
  });

  it('200 soft-deletes (status=suspended) preserving audit trail', async () => {
    const res = await api.request('DELETE', `/api/dev/apps/${APP}`, { bearer: cookie1 });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; suspended_client_id: string };
    expect(json.ok).toBe(true);
    expect(json.suspended_client_id).toBe(APP);

    // Verify status='suspended'（NOT physical DELETE）：資料列仍在，其餘欄位保留
    const row = await appRow(APP);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ status: 'suspended', app_name: 'Trip Buddy', owner_user_id: U1 });
  });
});
