/**
 * /api/account/connected-apps — V2-P5 user-side OAuth grant management
 * 走 HTTP 邊界（tests/api/http.ts），以真實 session cookie 認證；
 * 原本檢查 mock DB「bind 呼叫形狀」的斷言，改讀真實 D1 的資料變化。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const SESSION_SECRET = 'test-secret-32-chars-long-enough';
// 共用 D1：專用 id／email，結束時清掉自己的資料
const U1 = 'ca-user-1';
const U2 = 'ca-user-2';
const EMAIL1 = 'ca-user-1@example.com';
const EMAIL2 = 'ca-user-2@example.com';
const APP = 'ca_tp_abc';
const OTHER_APP = 'ca_tp_other';

let db: D1Database;
let api: Api;
let cookie1: string;

async function seedConsent(userId: string, clientId: string, scopes = ['openid'], grantedAt = Date.now()) {
  await new D1Adapter(db, 'Consent').upsert(
    `${userId}:${clientId}`,
    { user_id: userId, client_id: clientId, scopes, grantedAt } as never,
    3600,
  );
}

async function seedToken(name: 'AccessToken' | 'RefreshToken', id: string, userId: string, clientId: string) {
  await new D1Adapter(db, name).upsert(id, { user_id: userId, client_id: clientId } as never, 3600);
}

async function cleanOauthRows() {
  await db.prepare(`DELETE FROM oauth_models WHERE json_extract(payload, '$.user_id') IN (?, ?)`).bind(U1, U2).run();
}

async function countModels(name: string, id: string): Promise<number> {
  const row = await db.prepare('SELECT count(*) AS n FROM oauth_models WHERE name = ? AND id = ?').bind(name, id).first<{ n: number }>();
  return row!.n;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET }) });
  for (const [id, name] of [[APP, 'Trip Buddy'], [OTHER_APP, 'Other App']]) {
    await db.prepare(
      `INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, app_description, homepage_url, redirect_uris, allowed_scopes, status)
       VALUES (?, 'public', ?, 'Trip companion app', 'https://tripbuddy.example.com', '[]', '[]', 'active')`,
    ).bind(id, name).run();
  }
}, 30000);

// 每個測試前清掉該使用者的 oauth_models（含登入用的 token），再重新發一組。
beforeEach(async () => {
  await cleanOauthRows();
  cookie1 = (await sessionFor(db, EMAIL1, U1)).bearer;
  await sessionFor(db, EMAIL2, U2);
});

afterAll(async () => {
  await cleanOauthRows();
  await db.prepare('DELETE FROM client_apps WHERE client_id IN (?, ?)').bind(APP, OTHER_APP).run();
  await db.prepare('DELETE FROM session_devices WHERE user_id IN (?, ?)').bind(U1, U2).run();
  await db.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(U1, U2).run();
  await disposeMiniflare();
});

describe('GET /api/account/connected-apps', () => {
  it('401 when no session', async () => {
    const res = await api.get('/api/account/connected-apps');
    expect(res.status).toBe(401);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('AUTH_REQUIRED');
  });

  it('200 returns empty list when no consents', async () => {
    const res = await api.get('/api/account/connected-apps', { bearer: cookie1 });
    expect(res.status).toBe(200);
    const json = await res.json() as { apps: unknown[] };
    expect(json.apps).toEqual([]);
  });

  it('200 returns connected apps with merged consent + client_app data', async () => {
    await seedConsent(U1, APP, ['openid', 'profile', 'trips.read'], 1700000000000);
    const res = await api.get('/api/account/connected-apps', { bearer: cookie1 });
    const json = await res.json() as { apps: Array<Record<string, unknown>> };

    expect(json.apps).toHaveLength(1);
    expect(json.apps[0]).toMatchObject({
      client_id: APP,
      app_name: 'Trip Buddy',
      scopes: ['openid', 'profile', 'trips.read'],
      granted_at: 1700000000000,
      status: 'active',
    });
  });

  it('依授權時間由新到舊排序', async () => {
    await seedConsent(U1, APP, ['openid'], 1000);
    await seedConsent(U1, OTHER_APP, ['openid'], 2000);
    const res = await api.get('/api/account/connected-apps', { bearer: cookie1 });
    const json = await res.json() as { apps: Array<{ client_id: string }> };
    expect(json.apps.map(a => a.client_id)).toEqual([OTHER_APP, APP]);
  });

  it('只回 session 使用者自己的授權（不吃 query 的 user_id）', async () => {
    await seedConsent(U1, APP);
    await seedConsent(U2, OTHER_APP);
    const res = await api.get(`/api/account/connected-apps?user_id=${U2}`, { bearer: cookie1 });
    const json = await res.json() as { apps: Array<{ client_id: string }> };
    expect(json.apps.map(a => a.client_id)).toEqual([APP]);
  });
});

describe('DELETE /api/account/connected-apps/:client_id', () => {
  it('401 when no session', async () => {
    const res = await api.request('DELETE', `/api/account/connected-apps/${APP}`, {
      
    });
    expect(res.status).toBe(401);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('AUTH_REQUIRED');
  });

  it('client_id 為空（結尾斜線）→ 不會進 [client_id]，回 404', async () => {
    // 經真實路由，空的 client_id 到不了 [client_id].ts —— 結尾斜線落在 connected-apps.ts（只有 GET）。
    const res = await api.request('DELETE', '/api/account/connected-apps/', { bearer: cookie1 });
    // 行為差異：舊入口落在只有 GET 的 connected-apps.ts → 405；新 api 沒有登記該路徑 → 404。
    expect(res.status).toBe(404);

    // 註：[client_id].ts 內缺 client_id 的防呆分支在路由下不可達，
    // 所以不再直接呼叫 handler 斷言它；新 api 改由路由 schema 驗證路徑參數。
  });

  it('404 CONSENT_NOT_FOUND when no consent for (user, client)', async () => {
    const res = await api.request('DELETE', '/api/account/connected-apps/unknown_app', { bearer: cookie1 });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('CONSENT_NOT_FOUND');
  });

  it('200 destroys consent + all tokens for (user, client) pair', async () => {
    await seedConsent(U1, APP);
    await seedToken('AccessToken', 'ca-at-1', U1, APP);
    await seedToken('RefreshToken', 'ca-rt-1', U1, APP);
    // 不該被動到的：同使用者別的 app、別的使用者同一個 app
    await seedConsent(U1, OTHER_APP);
    await seedToken('AccessToken', 'ca-at-other-app', U1, OTHER_APP);
    await seedConsent(U2, APP);
    await seedToken('AccessToken', 'ca-at-other-user', U2, APP);

    const res = await api.request('DELETE', `/api/account/connected-apps/${APP}`, { bearer: cookie1 });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; revoked_client_id: string };
    expect(json.ok).toBe(true);
    expect(json.revoked_client_id).toBe(APP);

    // 同意紀錄 + 這組 (user, client) 的 access／refresh token 都消失
    expect(await countModels('Consent', `${U1}:${APP}`)).toBe(0);
    expect(await countModels('AccessToken', 'ca-at-1')).toBe(0);
    expect(await countModels('RefreshToken', 'ca-rt-1')).toBe(0);
    // 其他 app／其他使用者的資料不受影響
    expect(await countModels('Consent', `${U1}:${OTHER_APP}`)).toBe(1);
    expect(await countModels('AccessToken', 'ca-at-other-app')).toBe(1);
    expect(await countModels('Consent', `${U2}:${APP}`)).toBe(1);
    expect(await countModels('AccessToken', 'ca-at-other-user')).toBe(1);
  });

  it('Cannot revoke another user\'s consent (cross-user attack)', async () => {
    // user-1 試圖撤銷 tp_abc；授權只存在 user-2:tp_abc → user-1 看不到、也動不到
    await seedConsent(U2, APP);
    await seedToken('AccessToken', 'ca-at-victim', U2, APP);

    const res = await api.request('DELETE', `/api/account/connected-apps/${APP}`, { bearer: cookie1 });
    expect(res.status).toBe(404);

    expect(await countModels('Consent', `${U2}:${APP}`)).toBe(1);
    expect(await countModels('AccessToken', 'ca-at-victim')).toBe(1);
  });
});
