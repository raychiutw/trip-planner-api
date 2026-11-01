/**
 * /api/account/ai-authorization — owner 就地授權 Tripline AI（tp-request）幫排行程（Approach B）。
 * 走 HTTP 邊界（tests/api/http.ts）：session 是真實簽出的 cookie，Consent 是真實的 oauth_models 資料列。
 * 鎖不變式：
 *   - GET：Consent 存在 → {authorized:true}；不存在 → {authorized:false}
 *   - POST：upsert Consent `${uid}:tripline-tp-request`（scopes openid/profile、1yr TTL）→ {authorized:true}
 *   - 只授權固定 AI client（endpoint 不吃外部 client_id）→ 無提權面
 *   - session 必須：沒有 session → 不查、不寫
 *
 * 形式改變的斷言（原本斷言 mock 的呼叫參數）：
 *   - 「查的是 user 對 tp-request 的 key」→ 別人的 Consent、同 user 其他 client 的 Consent 都不算，只有正確 key 才 true
 *   - 「upsert 的 key／payload／ttl」→ 讀 oauth_models 真實資料列（id、payload、expires_at）
 *   - 「未登入 → 不查／不 upsert」→ 不帶 session cookie 的請求回 401，且 oauth_models 沒有新資料列
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const SESSION_SECRET = 'test-secret-32-chars-long-enough';
// 共用 D1：專用 id／email
const UID = 'aiauth-user-1';
const EMAIL = 'aiauth-user-1@example.com';
const OTHER_UID = 'aiauth-user-2';
const OTHER_EMAIL = 'aiauth-user-2@example.com';
const VICTIM_UID = 'aiauth-victim';
const CLIENT = 'tripline-tp-request';
const YEAR_SEC = 365 * 24 * 60 * 60;

let db: D1Database;
let api: Api;
let cookie: string;

const consentRows = () =>
  db.prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'Consent' AND id LIKE 'aiauth-%' ORDER BY id").all<{
    id: string;
    payload: string;
    expires_at: number;
  }>();

async function cleanConsents() {
  await db.prepare("DELETE FROM oauth_models WHERE name = 'Consent' AND id LIKE 'aiauth-%'").run();
}

async function seedConsent(key: string, userId: string, clientId = CLIENT) {
  await new D1Adapter(db, 'Consent').upsert(key, { user_id: userId, client_id: clientId, scopes: [], grantedAt: 1 }, 300);
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET }) });
  cookie = (await sessionFor(db, EMAIL, UID)).bearer;
}, 30000);

beforeEach(cleanConsents);

afterAll(async () => {
  await cleanConsents();
  await db.prepare("DELETE FROM oauth_models WHERE name = 'AccessToken' AND json_extract(payload, '$.user_id') IN (?, ?)").bind(UID, OTHER_UID).run();
  await db.prepare("DELETE FROM oauth_models WHERE id = 'aiauth-svc'").run();
  await db.prepare('DELETE FROM auth_audit_log WHERE user_id IN (?, ?)').bind(UID, OTHER_UID).run();
  await db.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(UID, OTHER_UID).run();
  await disposeMiniflare();
});

describe('GET /api/account/ai-authorization', () => {
  it('Consent 存在 → authorized:true，查的是 user 對 tp-request 的 key', async () => {
    // 別人的 Consent、同 user 對其他 client 的 Consent 都不算
    await seedConsent(`${OTHER_UID}:${CLIENT}`, OTHER_UID);
    await seedConsent(`${UID}:aiauth-other-client`, UID, 'aiauth-other-client');
    expect(await (await api.get('/api/account/ai-authorization', { bearer: cookie })).json()).toEqual({ authorized: false });

    await seedConsent(`${UID}:${CLIENT}`, UID);
    const res = await api.get('/api/account/ai-authorization', { bearer: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
  });

  it('Consent 不存在 → authorized:false', async () => {
    const res = await api.get('/api/account/ai-authorization', { bearer: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: false });
  });

  it('未登入（沒有 session）→ 401，不洩漏授權狀態', async () => {
    await seedConsent(`${UID}:${CLIENT}`, UID);
    // 匿名：middleware 擋
    const anon = await api.get('/api/account/ai-authorization');
    expect(anon.status).toBe(401);
    expect(JSON.stringify(await anon.json())).not.toContain('authorized');
    // 有效 bearer 但沒有使用者（service token）：通過 middleware，由 handler 的 requireAccountUser 擋
    await new D1Adapter(db, 'AccessToken').upsert('aiauth-svc', { client_id: 'svc', user_id: null, scopes: ['ops:read'], grantId: 'aiauth-g' }, 300);
    const bearerOnly = await api.get('/api/account/ai-authorization', { bearer: 'aiauth-svc' });
    expect(bearerOnly.status).toBe(401);
    const json = (await bearerOnly.json()) as { error: { code: string } };
    expect(json.error.code).toBe('AUTH_REQUIRED');
  });
});

describe('POST /api/account/ai-authorization', () => {
  it('upsert Consent `${uid}:tripline-tp-request`（openid/profile、1yr）→ authorized:true', async () => {
    const before = Date.now();
    const res = await api.request('POST', '/api/account/ai-authorization', { bearer: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });

    const rows = (await consentRows()).results;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(`${UID}:${CLIENT}`);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ user_id: UID, client_id: CLIENT });
    expect(payload.scopes).toEqual(['openid', 'profile']);
    // TTL 1 年（expires_at 為 unix ms）
    expect(row.expires_at - before).toBeGreaterThan(YEAR_SEC * 1000 - 60_000);
    expect(row.expires_at - before).toBeLessThan(YEAR_SEC * 1000 + 60_000);

    // 授權後 GET 立即反映
    expect(await (await api.get('/api/account/ai-authorization', { bearer: cookie })).json()).toEqual({ authorized: true });
  });

  it('未登入（沒有 session）→ 401，不 upsert', async () => {
    // 匿名：middleware 擋
    const anon = await api.request('POST', '/api/account/ai-authorization');
    expect(anon.status).toBe(401);
    // 有效 bearer 但沒有使用者（service token）：由 handler 的 requireAccountUser 擋
    await new D1Adapter(db, 'AccessToken').upsert('aiauth-svc', { client_id: 'svc', user_id: null, scopes: ['ops:read'], grantId: 'aiauth-g' }, 300);
    const bearerOnly = await api.request('POST', '/api/account/ai-authorization', { bearer: 'aiauth-svc' });
    expect(bearerOnly.status).toBe(401);
    expect(((await bearerOnly.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
    // 受限 token（trip-scoped）：不得發 AI 授權
    const restricted = await sessionFor(db, EMAIL, UID, { restrictTrip: 'some-trip' });
    expect((await api.request('POST', '/api/account/ai-authorization', { bearer: restricted.bearer })).status).toBe(403);
    expect((await consentRows()).results).toHaveLength(0);
  });

  // 頭號安全不變式：body 完全不被讀 → 惡意 client_id/user_id 無法提權/冒名。
  it('惡意 body（client_id/user_id）被忽略 → 仍用 session uid + 固定 client', async () => {
    const res = await api.request('POST', '/api/account/ai-authorization', {
      bearer: cookie,
      json: { client_id: 'attacker-client', user_id: VICTIM_UID },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorized: true });
    const rows = (await consentRows()).results;
    expect(rows.map(r => r.id)).toEqual([`${UID}:${CLIENT}`]); // 不是 victim / attacker-client
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ user_id: UID, client_id: CLIENT });
  });
});
