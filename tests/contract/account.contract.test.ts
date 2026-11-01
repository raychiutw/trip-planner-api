// @vitest-environment node
/**
 * account 組（帳號／開發者應用程式／行程成員權限／邀請）的契約測試。
 *
 * 走 HTTP 邊界：真實 bearer → middleware → handler；回應用「文件裡的那份 schema」驗證，
 * 而且多出任何未宣告的欄位都會失敗（見 tests/contract/support.ts）。
 * 另外記錄每條路由實際觸發過的狀態碼，最後一個測試要求「文件列出的每個狀態碼都有被觸發過」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip, seedUser, userIdFor } from '../baseline/helpers';
import { createApi, type Api, type RequestOptions } from '../baseline/http';
import { sessionFor } from '../baseline/account-session-helper';
import { INVITE_SECRET, seedInvitation } from '../baseline/invitations-http';
import { hashPassword } from '../../src/lib/password';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { createApp } from '../../src/app';
import { createMobileDeleteChallenge } from '../../src/lib/delete-reauth';
import { MOBILE_PROD_REDIRECT } from '../../src/lib/mobile-oauth';
import { ApiError } from '../../src/schemas/common';
import * as S from '../../src/schemas/account';
import { expectContract } from './support';

// 受測的全部路由（OpenAPI 路徑寫法）與 legacyRoute 的 auth 模式
const ROUTES: Array<[string, string, 'required' | 'optional']> = [
  ['get', '/api/account/ai-authorization', 'required'],
  ['post', '/api/account/ai-authorization', 'required'],
  ['get', '/api/account/connected-apps', 'required'],
  ['delete', '/api/account/connected-apps/{client_id}', 'required'],
  ['get', '/api/account', 'required'],
  ['delete', '/api/account', 'required'],
  ['post', '/api/account/delete-reauth', 'required'],
  ['get', '/api/account/delete-reauth', 'required'],
  ['delete', '/api/account/delete-reauth', 'required'],
  ['get', '/api/account/notifications', 'required'],
  ['patch', '/api/account/notifications', 'required'],
  ['patch', '/api/account/profile', 'required'],
  ['get', '/api/account/sessions', 'required'],
  ['delete', '/api/account/sessions', 'required'],
  ['delete', '/api/account/sessions/{sid}', 'required'],
  ['get', '/api/account/stats', 'required'],
  ['post', '/api/dev/apps', 'required'],
  ['get', '/api/dev/apps', 'required'],
  ['get', '/api/dev/apps/{client_id}', 'required'],
  ['patch', '/api/dev/apps/{client_id}', 'required'],
  ['delete', '/api/dev/apps/{client_id}', 'required'],
  ['get', '/api/permissions', 'required'],
  ['post', '/api/permissions', 'required'],
  ['delete', '/api/permissions/{id}', 'required'],
  ['patch', '/api/permissions/{id}', 'required'],
  ['get', '/api/invitations', 'optional'],
  ['post', '/api/invitations/accept', 'required'],
  ['post', '/api/invitations/revoke', 'required'],
];

let db: D1Database;
let api: Api;
let apiMobile: Api; // production 環境（mobile 的 delete-reauth 需要與環境相符的 client／callback）
let apiNoSecret: Api; // 沒有 SESSION_SECRET 的環境（觸發 500）

/** 每條路由實際觸發過的狀態碼，key = `${method} ${openapi path} ${status}`。 */
const triggered = new Set<string>();

/** 打一次請求並登記「這條路由 × 這個狀態碼」。 */
async function hit(route: string, method: string, path: string, opts: RequestOptions = {}, client: Api = api): Promise<Response> {
  const res = await client.request(method.toUpperCase(), path, opts);
  triggered.add(`${method} ${route} ${res.status}`);
  return res;
}

/** 送出前先用文件的 body schema 驗證：測試送的 body 必須是「文件認為合法」的。 */
function valid<T>(schema: Parameters<typeof expectContract>[0], body: T): T { expectContract(schema, body); return body; }
/** handler 實際拒絕的 body，文件的 body schema 也必須判定不合法（文件與 handler 的規則一致）。 */
function invalid<T>(schema: Parameters<typeof expectContract>[0], body: T): T {
  expect(schema.safeParse(body).success, `文件的 schema 應判定不合法：${JSON.stringify(body)}`).toBe(false);
  return body;
}

async function expectApiError(res: Response, status: number, code?: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = await res.json();
  expectContract(ApiError, body);
  if (code) expect((body as { error: { code: string } }).error.code).toBe(code);
}

const OWNER = 'acct-owner@test.com';
const MEMBER = 'acct-member@test.com';
const STRANGER = 'acct-stranger@test.com';
const TRIP = 'acct-trip';
let ownerBearer: string;
let strangerBearer: string;
let thirdPartyBearer: string;
let restrictedBearer: string;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET: INVITE_SECRET }) });
  apiNoSecret = createApi({ env: mockEnv(db) });
  apiMobile = createApi({ env: mockEnv(db, { SESSION_SECRET: INVITE_SECRET, ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.test', MOBILE_OAUTH_CALLBACK_URL: MOBILE_PROD_REDIRECT }) });

  await seedTrip(db, { id: TRIP, owner: OWNER });
  await seedUser(db, MEMBER);
  await db.prepare(`INSERT INTO trip_permissions (trip_id, role, user_id) VALUES (?, 'member', ?)`).bind(TRIP, userIdFor(MEMBER)).run();
  await db.prepare(
    `INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status, first_party)
     VALUES ('acct-third-party', 'public', 'Third Party', '[]', '[]', 'active', 0)`,
  ).run();

  ownerBearer = (await sessionFor(db, OWNER)).bearer;
  strangerBearer = (await sessionFor(db, STRANGER)).bearer;
  thirdPartyBearer = (await sessionFor(db, OWNER, undefined, { clientId: 'acct-third-party' })).bearer;
  restrictedBearer = (await sessionFor(db, OWNER, undefined, { restrictTrip: TRIP })).bearer;
}, 30000);

afterAll(async () => { await disposeMiniflare(); });

// ───────── 文件本身 ─────────

describe('/openapi.json 涵蓋 account 組每一條路由', () => {
  it('每條路由都有 responses（含至少一個有 schema 的成功回應）、security 與 auth 模式一致、寫入類有 requestBody', async () => {
    const res = await createApp().request('/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, Record<string, {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      security?: Array<Record<string, unknown>>;
      requestBody?: unknown;
    }>> };
    const problems: string[] = [];
    for (const [method, path, auth] of ROUTES) {
      const op = spec.paths[path]?.[method];
      const tag = `${method.toUpperCase()} ${path}`;
      if (!op) { problems.push(`${tag}：不在 openapi.json`); continue; }
      const responses = op.responses ?? {};
      const successes = Object.entries(responses).filter(([code]) => code.startsWith('2'));
      const hasTypedSuccess = successes.some(([, r]) => r.content?.['application/json']?.schema !== undefined
        && JSON.stringify(r.content['application/json'].schema) !== JSON.stringify({}));
      if (!hasTypedSuccess) problems.push(`${tag}：沒有帶 schema 的 2xx 回應`);
      if (!responses['401']) problems.push(`${tag}：缺 401 文件`);
      const expectSecurity = auth === 'required' ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}];
      if (JSON.stringify(op.security) !== JSON.stringify(expectSecurity)) problems.push(`${tag}：security 與 auth=${auth} 不一致`);
      if (['post', 'patch'].includes(method) && !['/api/account/ai-authorization', '/api/account/delete-reauth'].includes(path) && !op.requestBody) {
        // 這些寫入類路由沒有 body：POST ai-authorization、DELETE sessions；其餘一律要有
        problems.push(`${tag}：缺 requestBody`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('DELETE /api/account 的 requestBody 有寫（帶 password 或 confirm）', async () => {
    const spec = (await (await createApp().request('/openapi.json')).json()) as { paths: Record<string, Record<string, { requestBody?: unknown }>> };
    expect(spec.paths['/api/account']?.delete?.requestBody).toBeTruthy();
  });
});

// ───────── ai-authorization ─────────

describe('/api/account/ai-authorization', () => {
  it('GET → 200 未授權；POST → 200 已授權；再 GET → true', async () => {
    const g1 = await hit('/api/account/ai-authorization', 'get', '/api/account/ai-authorization', { bearer: ownerBearer });
    expect(g1.status).toBe(200);
    const b1 = await g1.json();
    expectContract(S.Account_AiAuthorizationStatus, b1);
    expect(b1).toEqual({ authorized: false });
    const p = await hit('/api/account/ai-authorization', 'post', '/api/account/ai-authorization', { bearer: ownerBearer });
    expect(p.status).toBe(200);
    const pb = await p.json();
    expectContract(S.Account_AiAuthorizationStatus, pb);
    expect(pb).toEqual({ authorized: true });
    const g2 = await api.get('/api/account/ai-authorization', { bearer: ownerBearer });
    expect(await g2.json()).toEqual({ authorized: true });
  });
  it('未登入 → 401；第三方 client／受限 token → 403', async () => {
    for (const m of ['get', 'post']) {
      await expectApiError(await hit('/api/account/ai-authorization', m, '/api/account/ai-authorization'), 401, 'AUTH_REQUIRED');
      await expectApiError(await hit('/api/account/ai-authorization', m, '/api/account/ai-authorization', { bearer: thirdPartyBearer }), 403, 'PERM_DENIED');
    }
  });
});

// ───────── connected-apps ─────────

describe('/api/account/connected-apps', () => {
  it('GET 列出授權；DELETE 撤銷 → 200；再撤銷 → 404 CONSENT_NOT_FOUND', async () => {
    const s = await sessionFor(db, 'acct-ca@test.com');
    await db.prepare(
      `INSERT OR REPLACE INTO client_apps (client_id, client_type, app_name, app_description, homepage_url, redirect_uris, allowed_scopes, status)
       VALUES ('acct_ca_app', 'public', 'CA App', 'desc', 'https://ca.example.com', '[]', '[]', 'active')`,
    ).run();
    await new D1Adapter(db, 'Consent').upsert(`${s.userId}:acct_ca_app`, { user_id: s.userId, client_id: 'acct_ca_app', scopes: ['openid'], grantedAt: Date.now() } as never, 3600);

    const list = await hit('/api/account/connected-apps', 'get', '/api/account/connected-apps', { bearer: s.bearer });
    expect(list.status).toBe(200);
    const body = await list.json();
    expectContract(S.Account_ConnectedAppsList, body);
    expect((body as { apps: unknown[] }).apps).toHaveLength(1);

    const del = await hit('/api/account/connected-apps/{client_id}', 'delete', '/api/account/connected-apps/acct_ca_app', { bearer: s.bearer });
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expectContract(S.Account_ConnectedAppRevoked, delBody);
    expect(delBody).toEqual({ ok: true, revoked_client_id: 'acct_ca_app' });

    await expectApiError(await hit('/api/account/connected-apps/{client_id}', 'delete', '/api/account/connected-apps/acct_ca_app', { bearer: s.bearer }), 404, 'CONSENT_NOT_FOUND');
  });
  it('未登入 → 401；第三方 client → 403', async () => {
    await expectApiError(await hit('/api/account/connected-apps', 'get', '/api/account/connected-apps'), 401);
    await expectApiError(await hit('/api/account/connected-apps', 'get', '/api/account/connected-apps', { bearer: thirdPartyBearer }), 403);
    await expectApiError(await hit('/api/account/connected-apps/{client_id}', 'delete', '/api/account/connected-apps/x'), 401);
    await expectApiError(await hit('/api/account/connected-apps/{client_id}', 'delete', '/api/account/connected-apps/x', { bearer: thirdPartyBearer }), 403);
  });
});

// ───────── 帳號刪除 ─────────

describe('/api/account（刪除預覽／刪除）', () => {
  it('GET 預覽 → 200（owner 有一個行程、一位共編者）', async () => {
    const res = await hit('/api/account', 'get', '/api/account', { bearer: ownerBearer });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_DeletePreview, body);
    expect(body).toEqual({ hasPassword: false, reauthProvider: null, reauthenticated: false, tripsOwned: 1, collaboratorsAffected: 1 });
  });

  it('DELETE：沒帶確認 → 400 ACCOUNT_DELETE_CONFIRM_REQUIRED；有密碼帳號密碼錯 → 401 ACCOUNT_DELETE_PASSWORD_INVALID；成功 → 200', async () => {
    // 無密碼帳號（mobile client＋Google 身分）：只帶 confirm 被拒（fail-closed），完成 challenge 才能刪
    const oauth = await sessionFor(db, 'acct-del-oauth@test.com', undefined, { clientId: 'tripline-mobile' });
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', 'acct-del-oauth-sub')").bind(oauth.userId).run();
    expectContract(S.Account_DeletePreview, await (await api.get('/api/account', { bearer: oauth.bearer })).json());
    await expectApiError(await hit('/api/account', 'delete', 'https://api.test/api/account', { bearer: oauth.bearer, json: {} }, apiMobile), 400, 'ACCOUNT_DELETE_CONFIRM_REQUIRED');
    await expectApiError(await hit('/api/account', 'delete', 'https://api.test/api/account', { bearer: oauth.bearer, json: invalid(S.Account_DeleteBody, { confirm: 'delete' }) }, apiMobile), 400, 'ACCOUNT_DELETE_CONFIRM_REQUIRED');
    await expectApiError(await hit('/api/account', 'delete', 'https://api.test/api/account', { bearer: oauth.bearer, json: valid(S.Account_DeleteBody, { confirm: 'DELETE' }) }, apiMobile), 403, 'ACCOUNT_DELETE_REAUTH_REQUIRED');
    const challengeId = await createMobileDeleteChallenge(db, oauth.userId, oauth.grantId, 'tripline-mobile');
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.status', 'verified') WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(challengeId).run();
    const ok = await hit('/api/account', 'delete', 'https://api.test/api/account', { bearer: oauth.bearer, json: valid(S.Account_DeleteBody, { confirm: 'DELETE', challengeId }) }, apiMobile);
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expectContract(S.Account_DeleteResult, okBody);
    expect((okBody as { ok: boolean }).ok).toBe(true);
    // 刪除後 token 立即失效
    await expectApiError(await api.get('/api/account', { bearer: oauth.bearer }), 401, 'AUTH_REQUIRED');

    // 有密碼的帳號
    const pw = await sessionFor(db, 'acct-del-pw@test.com');
    await db.prepare(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')`,
    ).bind(pw.userId, 'acct-del-pw@test.com', await hashPassword('correct-horse-1')).run();
    const preview = await api.get('/api/account', { bearer: pw.bearer });
    expect(((await preview.json()) as { hasPassword: boolean }).hasPassword).toBe(true);
    // 有密碼帳號：缺 password、password 不是字串 → handler 400；password 不是字串時文件的 schema 也判定不合法
    await expectApiError(await hit('/api/account', 'delete', '/api/account', { bearer: pw.bearer, json: {} }), 400, 'ACCOUNT_DELETE_CONFIRM_REQUIRED');
    await expectApiError(await hit('/api/account', 'delete', '/api/account', { bearer: pw.bearer, json: invalid(S.Account_DeleteBody, { password: 123 }) }), 400, 'ACCOUNT_DELETE_CONFIRM_REQUIRED');
    await expectApiError(await hit('/api/account', 'delete', '/api/account', { bearer: pw.bearer, json: { password: 'wrong' } }), 401, 'ACCOUNT_DELETE_PASSWORD_INVALID');
    const ok2 = await hit('/api/account', 'delete', '/api/account', { bearer: pw.bearer, json: valid(S.Account_DeleteBody, { password: 'correct-horse-1' }) });
    expect(ok2.status).toBe(200);
    expectContract(S.Account_DeleteResult, await ok2.json());
  });

  it('web（tripline-web）無密碼帳號：預覽 reauthenticated 隨 verified challenge 變 true；DELETE 只帶 { challengeId }；web 只帶 confirm → 403', async () => {
    const w = await sessionFor(db, 'acct-del-web@test.com', undefined, { clientId: 'tripline-web' });
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', 'acct-del-web-sub')").bind(w.userId).run();
    const U = 'https://api.test/api/account';
    const preview = async () => (await (await apiMobile.request('GET', U, { bearer: w.bearer })).json()) as { reauthProvider: string; reauthenticated: boolean };
    expect(await preview()).toMatchObject({ reauthProvider: 'google', reauthenticated: false });
    await expectApiError(await hit('/api/account', 'delete', U, { bearer: w.bearer, json: valid(S.Account_DeleteBody, { confirm: 'DELETE' }) }, apiMobile), 403, 'ACCOUNT_DELETE_REAUTH_REQUIRED');
    const created = await (await apiMobile.request('POST', 'https://api.test/api/account/delete-reauth', { bearer: w.bearer })).json() as { challengeId: string };
    expectContract(S.Account_DeleteReauthStarted, created);
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.status', 'verified') WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(created.challengeId).run();
    expect((await preview()).reauthenticated).toBe(true);
    const ok = await hit('/api/account', 'delete', U, { bearer: w.bearer, json: valid(S.Account_DeleteBody, { challengeId: created.challengeId }) }, apiMobile);
    expect(ok.status).toBe(200);
    expectContract(S.Account_DeleteResult, await ok.json());
  });

  it('未登入 → 401 AUTH_REQUIRED；第三方 client → 403', async () => {
    await expectApiError(await hit('/api/account', 'get', '/api/account'), 401, 'AUTH_REQUIRED');
    await expectApiError(await hit('/api/account', 'delete', '/api/account', { json: { confirm: 'DELETE' } }), 401, 'AUTH_REQUIRED');
    await expectApiError(await hit('/api/account', 'get', '/api/account', { bearer: thirdPartyBearer }), 403);
    await expectApiError(await hit('/api/account', 'delete', '/api/account', { bearer: thirdPartyBearer, json: { confirm: 'DELETE' } }), 403, 'PERM_DENIED');
  });
});

// ───────── 帳號刪除的 Google 重新驗證 challenge ─────────

describe('/api/account/delete-reauth', () => {
  const R = '/api/account/delete-reauth';
  const call = (method: string, bearer: string | undefined, qs = '', client: Api = apiMobile) =>
    hit(R, method.toLowerCase(), `https://api.test${R}${qs}`, { bearer }, client);

  it('POST 建立 challenge → 200（challengeId／authorizeUrl／expiresIn=300）；GET 查狀態 → 200；DELETE 取消 → 200', async () => {
    const s = await sessionFor(db, 'acct-reauth@test.com', undefined, { clientId: 'tripline-mobile' });
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', 'acct-reauth-sub')").bind(s.userId).run();
    const created = await call('POST', s.bearer);
    expect(created.status).toBe(200);
    const body = await created.json() as { challengeId: string };
    expectContract(S.Account_DeleteReauthStarted, body);
    const qs = `?challenge_id=${body.challengeId}`;
    const status = await call('GET', s.bearer, qs);
    expect(status.status).toBe(200);
    expectContract(S.Account_DeleteReauthStatus, await status.json());
    // 過期 → status: expired（同一個 schema）
    await db.prepare("UPDATE oauth_models SET expires_at = 1 WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(body.challengeId).run();
    const expired = await (await apiMobile.request('GET', `https://api.test${R}${qs}`, { bearer: s.bearer })).json();
    expectContract(S.Account_DeleteReauthStatus, expired);
    expect(expired).toEqual({ status: 'expired', expiresIn: 0 });
    const fresh = await (await call('POST', s.bearer)).json() as { challengeId: string };
    const cancelled = await call('DELETE', s.bearer, `?challenge_id=${fresh.challengeId}`);
    expect(cancelled.status).toBe(200);
    expectContract(S.Account_DeleteReauthCancelled, await cancelled.json());
    // failed 的取消收尾（冪等）也符合同一個 schema
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.status', 'failed') WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(fresh.challengeId).run();
    const failed = await apiMobile.request('DELETE', `https://api.test${R}?challenge_id=${fresh.challengeId}`, { bearer: s.bearer });
    expectContract(S.Account_DeleteReauthCancelled, await failed.json());
    expect(await db.prepare("SELECT 1 FROM oauth_models WHERE id = ?").bind(fresh.challengeId).first()).not.toBeNull();
  });

  it('錯誤：401 未登入；403 非 mobile／web client／沒有 Google 身分／已過期的取消；400 沒帶 challenge_id；404 別人的；409 已 used；500 設定不符', async () => {
    const s = await sessionFor(db, 'acct-reauth-err@test.com', undefined, { clientId: 'tripline-mobile' });
    const other = await sessionFor(db, 'acct-reauth-err-other@test.com', undefined, { clientId: 'tripline-mobile' });
    for (const m of ['POST', 'GET', 'DELETE']) await expectApiError(await call(m, undefined, '?challenge_id=x'), 401, 'AUTH_REQUIRED');
    // 非 mobile 非 web 的 client
    const web = (await sessionFor(db, 'acct-reauth-err@test.com', undefined, { clientId: 'tripline-tp-request' })).bearer;
    for (const m of ['POST', 'GET', 'DELETE']) await expectApiError(await call(m, web, '?challenge_id=x'), 403, 'PERM_DENIED');
    // 沒有 Google 身分 → 403 ACCOUNT_DELETE_REAUTH_REQUIRED
    await expectApiError(await call('POST', s.bearer), 403, 'ACCOUNT_DELETE_REAUTH_REQUIRED');
    // 400
    await expectApiError(await call('GET', s.bearer), 400, 'DATA_VALIDATION');
    await expectApiError(await call('DELETE', s.bearer), 400, 'DATA_VALIDATION');
    // 404：不存在、別人的
    const mine = await createMobileDeleteChallenge(db, s.userId, s.grantId, 'tripline-mobile');
    await expectApiError(await call('GET', s.bearer, '?challenge_id=nope'), 404, 'DATA_NOT_FOUND');
    await expectApiError(await call('GET', other.bearer, `?challenge_id=${mine}`), 404, 'DATA_NOT_FOUND');
    await expectApiError(await call('DELETE', other.bearer, `?challenge_id=${mine}`), 404, 'DATA_NOT_FOUND');
    // 過期的取消 → 403 REAUTH_REQUIRED；used → 409
    await db.prepare("UPDATE oauth_models SET expires_at = 1 WHERE id = ?").bind(mine).run();
    await expectApiError(await call('DELETE', s.bearer, `?challenge_id=${mine}`), 403, 'ACCOUNT_DELETE_REAUTH_REQUIRED');
    const used = await createMobileDeleteChallenge(db, s.userId, s.grantId, 'tripline-mobile');
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.status', 'used') WHERE id = ?").bind(used).run();
    await expectApiError(await call('DELETE', s.bearer, `?challenge_id=${used}`), 409, 'DATA_CONFLICT');
    // 500：callback 設定與環境契約不符
    await db.prepare("INSERT OR IGNORE INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', 'acct-reauth-err-sub')").bind(s.userId).run();
    const misconfigured = createApi({ env: mockEnv(db, { ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.test', MOBILE_OAUTH_CALLBACK_URL: 'https://evil.example/cb' }) });
    await expectApiError(await call('POST', s.bearer, '', misconfigured), 500, 'SERVER_MISCONFIG');
  });
});

// ───────── notifications ─────────

describe('/api/account/notifications', () => {
  it('GET 預設全開；PATCH 更新 → 200', async () => {
    const s = await sessionFor(db, 'acct-notif@test.com');
    const g = await hit('/api/account/notifications', 'get', '/api/account/notifications', { bearer: s.bearer });
    expect(g.status).toBe(200);
    const gb = await g.json();
    expectContract(S.Account_NotificationPreferencesResponse, gb);
    expect(gb).toEqual({ preferences: { tripUpdates: true, invitations: true, system: true, updatedAt: null } });

    const p = await hit('/api/account/notifications', 'patch', '/api/account/notifications', { bearer: s.bearer, json: valid(S.Account_NotificationPatchBody, { system: false }) });
    expect(p.status).toBe(200);
    const pb = await p.json();
    expectContract(S.Account_NotificationPreferencesResponse, pb);
    expect((pb as { preferences: { system: boolean; updatedAt: string } }).preferences.system).toBe(false);
    expect(typeof (pb as { preferences: { updatedAt: string } }).preferences.updatedAt).toBe('string');
  });
  it('PATCH 400：未知欄位／非 boolean／空物件', async () => {
    for (const json of [{ bogus: true }, invalid(S.Account_NotificationPatchBody, { system: 'yes' })]) {
      await expectApiError(await hit('/api/account/notifications', 'patch', '/api/account/notifications', { bearer: ownerBearer, json }), 400, 'DATA_VALIDATION');
    }
  });
  it('未登入 → 401；第三方 client → 403', async () => {
    for (const m of ['get', 'patch']) {
      await expectApiError(await hit('/api/account/notifications', m, '/api/account/notifications', m === 'patch' ? { json: { system: true } } : {}), 401);
      await expectApiError(await hit('/api/account/notifications', m, '/api/account/notifications', { bearer: thirdPartyBearer, ...(m === 'patch' ? { json: { system: true } } : {}) }), 403);
    }
  });
});

// ───────── profile ─────────

describe('PATCH /api/account/profile', () => {
  it('→ 200 回 userinfo 形狀；null 清除', async () => {
    const s = await sessionFor(db, 'acct-profile@test.com');
    const res = await hit('/api/account/profile', 'patch', '/api/account/profile', { bearer: s.bearer, json: valid(S.Account_ProfilePatchBody, { displayName: '  小明  ' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_Profile, body);
    expect((body as { displayName: string }).displayName).toBe('小明');
    const cleared = await api.request('PATCH', '/api/account/profile', { bearer: s.bearer, json: valid(S.Account_ProfilePatchBody, { displayName: null }) });
    const cb = await cleared.json();
    expectContract(S.Account_Profile, cb);
    expect((cb as { displayName: unknown }).displayName).toBeNull();
  });
  it('400：空物件／型別錯／超過 50 字', async () => {
    for (const json of [{}, invalid(S.Account_ProfilePatchBody, { displayName: 5 }), invalid(S.Account_ProfilePatchBody, { displayName: 'x'.repeat(51) })]) {
      await expectApiError(await hit('/api/account/profile', 'patch', '/api/account/profile', { bearer: ownerBearer, json }), 400, 'DATA_VALIDATION');
    }
  });
  it('未登入 → 401；受限 token → 403 PERM_DENIED', async () => {
    await expectApiError(await hit('/api/account/profile', 'patch', '/api/account/profile', { json: { displayName: 'a' } }), 401);
    await expectApiError(await hit('/api/account/profile', 'patch', '/api/account/profile', { bearer: restrictedBearer, json: { displayName: 'a' } }), 403, 'PERM_DENIED');
  });
});

// ───────── sessions ─────────

describe('/api/account/sessions（以 OAuth grant 為單位）', () => {
  it('GET → 200：sid 是 grantId、ip_hash_prefix 恆為 null、有 client_id；is_current 標出目前這個', async () => {
    const a = await sessionFor(db, 'acct-sess@test.com');
    const b = await sessionFor(db, 'acct-sess@test.com');
    const res = await hit('/api/account/sessions', 'get', '/api/account/sessions', { bearer: a.bearer });
    expect(res.status).toBe(200);
    const body = await res.json() as { current_sid: string; sessions: Array<{ sid: string; client_id: string; ip_hash_prefix: null; is_current: boolean; ua_summary: string }> };
    expectContract(S.Account_SessionsList, body);
    expect(body.current_sid).toBe(a.grantId);
    expect(body.sessions.map((s) => s.sid).sort()).toEqual([a.grantId, b.grantId].sort());
    for (const s of body.sessions) {
      expect(s.ip_hash_prefix).toBeNull();
      expect(s.client_id).toBe('tripline-web');
      expect(s.ua_summary).toBe('Tripline Web');
    }
    expect(body.sessions.find((s) => s.sid === a.grantId)!.is_current).toBe(true);
    expect(body.sessions.find((s) => s.sid === b.grantId)!.is_current).toBe(false);
  });

  it('DELETE（其他全部）→ 200 revoked；DELETE /{sid} → 200；他人或不存在的 sid → 404 SESSION_NOT_FOUND', async () => {
    const me = await sessionFor(db, 'acct-sess2@test.com');
    const other1 = await sessionFor(db, 'acct-sess2@test.com');
    const other2 = await sessionFor(db, 'acct-sess2@test.com');
    const stranger = await sessionFor(db, 'acct-sess2-stranger@test.com');

    // 他人的 grantId 與不存在的都是 404
    await expectApiError(await hit('/api/account/sessions/{sid}', 'delete', `/api/account/sessions/${stranger.grantId}`, { bearer: me.bearer }), 404, 'SESSION_NOT_FOUND');
    await expectApiError(await hit('/api/account/sessions/{sid}', 'delete', '/api/account/sessions/nope', { bearer: me.bearer }), 404, 'SESSION_NOT_FOUND');

    const one = await hit('/api/account/sessions/{sid}', 'delete', `/api/account/sessions/${other1.grantId}`, { bearer: me.bearer });
    expect(one.status).toBe(200);
    const oneBody = await one.json();
    expectContract(S.Account_SessionRevoked, oneBody);
    expect(oneBody).toEqual({ ok: true, revoked_sid: other1.grantId });

    const others = await hit('/api/account/sessions', 'delete', '/api/account/sessions', { bearer: me.bearer });
    expect(others.status).toBe(200);
    const othersBody = await others.json();
    expectContract(S.Account_SessionsRevokedOthers, othersBody);
    expect(othersBody).toEqual({ ok: true, revoked: 1 }); // 只剩 other2；目前這個保留
    expect((await api.get('/api/account/sessions', { bearer: other2.bearer })).status).toBe(401);
    expect((await api.get('/api/account/sessions', { bearer: me.bearer })).status).toBe(200);
  });

  it('未登入 → 401；第三方 client → 403', async () => {
    await expectApiError(await hit('/api/account/sessions', 'get', '/api/account/sessions'), 401);
    await expectApiError(await hit('/api/account/sessions', 'get', '/api/account/sessions', { bearer: thirdPartyBearer }), 403);
    await expectApiError(await hit('/api/account/sessions', 'delete', '/api/account/sessions'), 401);
    await expectApiError(await hit('/api/account/sessions', 'delete', '/api/account/sessions', { bearer: thirdPartyBearer }), 403);
    await expectApiError(await hit('/api/account/sessions/{sid}', 'delete', '/api/account/sessions/x'), 401);
    await expectApiError(await hit('/api/account/sessions/{sid}', 'delete', '/api/account/sessions/x', { bearer: thirdPartyBearer }), 403);
  });
});

// ───────── stats ─────────

describe('GET /api/account/stats', () => {
  it('→ 200', async () => {
    const res = await hit('/api/account/stats', 'get', '/api/account/stats', { bearer: ownerBearer });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_Stats, body);
    expect(body).toEqual({ tripCount: 1, totalDays: 3, collaboratorCount: 1 });
  });
  it('未登入 → 401', async () => {
    await expectApiError(await hit('/api/account/stats', 'get', '/api/account/stats'), 401);
  });
});

// ───────── dev apps ─────────

describe('/api/dev/apps', () => {
  let publicId: string;
  let secretId: string;
  const dev = async () => (await sessionFor(db, 'acct-dev@test.com')).bearer;

  it('POST → 201：public 沒有 secret；confidential 有 secret（只出現一次）', async () => {
    const bearer = await dev();
    const pub = await hit('/api/dev/apps', 'post', '/api/dev/apps', { bearer, json: valid(S.Account_DevAppCreateBody, { app_name: 'Pub App', redirect_uris: ['https://pub.example.com/cb'] }) });
    expect(pub.status).toBe(201);
    const pubBody = await pub.json() as { client_id: string; client_secret: string | null };
    expectContract(S.Account_DevAppCreated, pubBody);
    expect(pubBody.client_secret).toBeNull();
    publicId = pubBody.client_id;

    const conf = await api.request('POST', '/api/dev/apps', { bearer, json: valid(S.Account_DevAppCreateBody, { app_name: 'Secret App', client_type: 'confidential', redirect_uris: ['http://localhost:3000/cb'], allowed_scopes: ['openid'], homepage_url: 'https://x.example.com', app_description: 'd' }) });
    expect(conf.status).toBe(201);
    const confBody = await conf.json() as { client_id: string; client_secret: string | null };
    expectContract(S.Account_DevAppCreated, confBody);
    expect(confBody.client_secret).toMatch(/^tps_/);
    secretId = confBody.client_id;
  });

  it('POST 400：名稱太短／redirect_uris 缺／http 非 localhost／越權 scope', async () => {
    const bearer = await dev();
    const bad = [
      invalid(S.Account_DevAppCreateBody, { app_name: 'x', redirect_uris: ['https://a.example.com'] }),
      invalid(S.Account_DevAppCreateBody, { app_name: 'x'.repeat(81), redirect_uris: ['https://a.example.com'] }),
      invalid(S.Account_DevAppCreateBody, { app_name: 'Good Name' }),
      { app_name: 'Good Name', redirect_uris: ['http://evil.example.com'] },
      invalid(S.Account_DevAppCreateBody, { app_name: 'Good Name', redirect_uris: ['https://a.example.com'], allowed_scopes: ['companion'] }),
    ];
    for (const json of bad) await expectApiError(await hit('/api/dev/apps', 'post', '/api/dev/apps', { bearer, json }), 400, 'DATA_VALIDATION');
  });

  it('GET 列表 → 200（沒有 app_logo_url）；GET 明細 → 200（有 app_logo_url）；他人的／不存在的 → 404 APP_NOT_FOUND', async () => {
    const bearer = await dev();
    const list = await hit('/api/dev/apps', 'get', '/api/dev/apps', { bearer });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { apps: unknown[] };
    expectContract(S.Account_DevAppList, listBody);
    expect(listBody.apps.length).toBeGreaterThanOrEqual(2);

    const detail = await hit('/api/dev/apps/{client_id}', 'get', `/api/dev/apps/${publicId}`, { bearer });
    expect(detail.status).toBe(200);
    expectContract(S.Account_DevApp, await detail.json());

    await expectApiError(await hit('/api/dev/apps/{client_id}', 'get', '/api/dev/apps/nope', { bearer }), 404, 'APP_NOT_FOUND');
    // 他人的 app 與不存在無從區分
    const other = (await sessionFor(db, 'acct-dev-other@test.com')).bearer;
    await expectApiError(await api.get(`/api/dev/apps/${publicId}`, { bearer: other }), 404, 'APP_NOT_FOUND');
  });

  it('PATCH → 200；400（空 body／越權 scope／空 scopes）；404', async () => {
    const bearer = await dev();
    const ok = await hit('/api/dev/apps/{client_id}', 'patch', `/api/dev/apps/${secretId}`, { bearer, json: valid(S.Account_DevAppPatchBody, { app_name: 'Renamed', app_description: '新描述', app_logo_url: 'https://logo.example.com/a.png', homepage_url: 'https://home.example.com', redirect_uris: ['https://r.example.com/cb'], allowed_scopes: ['openid', 'email'] }) });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { app_name: string; app_logo_url: string | null };
    expectContract(S.Account_DevApp, body);
    expect(body.app_name).toBe('Renamed');
    expect(body.app_logo_url).toBe('https://logo.example.com/a.png'); // 非 null 的案例
    // 明細（GET）也要帶出剛寫入的 logo
    const again = await api.get(`/api/dev/apps/${secretId}`, { bearer });
    expect(((await again.json()) as { app_logo_url: string }).app_logo_url).toBe('https://logo.example.com/a.png');
    // null 清除
    const cleared = await api.request('PATCH', `/api/dev/apps/${secretId}`, { bearer, json: valid(S.Account_DevAppPatchBody, { app_logo_url: null }) });
    const cb = await cleared.json();
    expectContract(S.Account_DevApp, cb);
    expect((cb as { app_logo_url: unknown }).app_logo_url).toBeNull();
    for (const json of [{}, { allowed_scopes: ['ops:maps'] }, invalid(S.Account_DevAppPatchBody, { allowed_scopes: [] }), invalid(S.Account_DevAppPatchBody, { app_name: 'x' }), invalid(S.Account_DevAppPatchBody, { app_name: 'x'.repeat(81) })]) {
      await expectApiError(await hit('/api/dev/apps/{client_id}', 'patch', `/api/dev/apps/${secretId}`, { bearer, json }), 400, 'DATA_VALIDATION');
    }
    await expectApiError(await hit('/api/dev/apps/{client_id}', 'patch', '/api/dev/apps/nope', { bearer, json: { app_name: 'Whatever' } }), 404, 'APP_NOT_FOUND');
  });

  it('DELETE → 200 軟刪除（status=suspended）；404', async () => {
    const bearer = await dev();
    const res = await hit('/api/dev/apps/{client_id}', 'delete', `/api/dev/apps/${publicId}`, { bearer });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_DevAppSuspended, body);
    expect(body).toEqual({ ok: true, suspended_client_id: publicId });
    const row = await db.prepare('SELECT status FROM client_apps WHERE client_id = ?').bind(publicId).first<{ status: string }>();
    expect(row?.status).toBe('suspended');
    await expectApiError(await hit('/api/dev/apps/{client_id}', 'delete', '/api/dev/apps/nope', { bearer }), 404, 'APP_NOT_FOUND');
  });

  it('未登入 → 401；第三方 client → 403', async () => {
    const cases: Array<[string, string, string, unknown]> = [
      ['/api/dev/apps', 'post', '/api/dev/apps', { app_name: 'Abc', redirect_uris: ['https://a.example.com'] }],
      ['/api/dev/apps', 'get', '/api/dev/apps', undefined],
      ['/api/dev/apps/{client_id}', 'get', '/api/dev/apps/x', undefined],
      ['/api/dev/apps/{client_id}', 'patch', '/api/dev/apps/x', { app_name: 'Abc' }],
      ['/api/dev/apps/{client_id}', 'delete', '/api/dev/apps/x', undefined],
    ];
    for (const [route, method, path, json] of cases) {
      await expectApiError(await hit(route, method, path, { json }), 401);
      await expectApiError(await hit(route, method, path, { bearer: thirdPartyBearer, json }), 403);
    }
  });
});

// ───────── permissions ─────────

describe('/api/permissions', () => {
  it('GET → 200 陣列（camelCase、含 owner 列）', async () => {
    const res = await hit('/api/permissions', 'get', `/api/permissions?tripId=${TRIP}`, { bearer: ownerBearer });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_PermissionList, body);
    expect((body as Array<{ role: string }>).some((r) => r.role === 'owner')).toBe(true);
  });

  it('GET 400 缺 tripId；403 非 owner／受限 token；404 行程不存在；401', async () => {
    await expectApiError(await hit('/api/permissions', 'get', '/api/permissions', { bearer: ownerBearer }), 400, 'DATA_VALIDATION');
    await expectApiError(await hit('/api/permissions', 'get', `/api/permissions?tripId=${TRIP}`, { bearer: strangerBearer }), 403, 'PERM_ADMIN_ONLY');
    await expectApiError(await hit('/api/permissions', 'get', `/api/permissions?tripId=${TRIP}`, { bearer: restrictedBearer }), 403, 'PERM_DENIED');
    await expectApiError(await hit('/api/permissions', 'get', '/api/permissions?tripId=no-such-trip', { bearer: ownerBearer }), 404, 'DATA_NOT_FOUND');
    await expectApiError(await hit('/api/permissions', 'get', `/api/permissions?tripId=${TRIP}`), 401);
  });

  it('POST：已註冊且已驗證 → 201 帶 id；未註冊 → 201 帶 expiresAt；重複 → 409 DATA_CONFLICT', async () => {
    const invitee = 'acct-invitee@test.com';
    await seedUser(db, invitee);
    await db.prepare(`UPDATE users SET email_verified_at = '2026-01-01T00:00:00Z' WHERE email = ?`).bind(invitee).run();

    const a = await hit('/api/permissions', 'post', '/api/permissions', { bearer: ownerBearer, json: valid(S.Account_PermissionCreateBody, { email: invitee, tripId: TRIP, role: 'viewer' }) });
    expect(a.status).toBe(201);
    const aBody = await a.json() as { id?: number; expiresAt?: string };
    expectContract(S.Account_PermissionCreated, aBody);
    expect(typeof aBody.id).toBe('number');

    await expectApiError(await hit('/api/permissions', 'post', '/api/permissions', { bearer: ownerBearer, json: { email: invitee, tripId: TRIP } }), 409, 'DATA_CONFLICT');

    const b = await hit('/api/permissions', 'post', '/api/permissions', { bearer: ownerBearer, json: valid(S.Account_PermissionCreateBody, { email: 'Acct-New-Person@Test.com', tripId: TRIP }) });
    expect(b.status).toBe(201);
    const bBody = await b.json() as { email: string; id?: number; expiresAt?: string };
    expectContract(S.Account_PermissionCreated, bBody);
    expect(bBody.email).toBe('acct-new-person@test.com');
    expect(typeof bBody.expiresAt).toBe('string');
    expect(bBody.id).toBeUndefined();

    // 同一個未註冊 email 已有 pending 邀請 → 409
    await expectApiError(await hit('/api/permissions', 'post', '/api/permissions', { bearer: ownerBearer, json: { email: 'acct-new-person@test.com', tripId: TRIP } }), 409, 'DATA_CONFLICT');
  });

  it('POST 400／401／403／404／500', async () => {
    const post = (json: unknown, bearer?: string, client: Api = api) => hit('/api/permissions', 'post', '/api/permissions', { bearer, json }, client);
    await expectApiError(await post(invalid(S.Account_PermissionCreateBody, { tripId: TRIP }), ownerBearer), 400, 'DATA_VALIDATION');
    await expectApiError(await post(invalid(S.Account_PermissionCreateBody, { email: 'a@b.com', tripId: TRIP, role: 'owner' }), ownerBearer), 400, 'DATA_VALIDATION');
    await expectApiError(await post({ email: 'not-an-email', tripId: TRIP }, ownerBearer), 400, 'DATA_VALIDATION');
    await expectApiError(await post({ email: 'a@b.com', tripId: TRIP }), 401);
    await expectApiError(await post({ email: 'a@b.com', tripId: TRIP }, strangerBearer), 403, 'PERM_ADMIN_ONLY');
    await expectApiError(await post({ email: 'a@b.com', tripId: TRIP }, restrictedBearer), 403, 'PERM_DENIED');
    await expectApiError(await post({ email: 'a@b.com', tripId: 'no-such-trip' }, ownerBearer), 404, 'DATA_NOT_FOUND');
    // 未註冊的 email 需要 SESSION_SECRET 簽邀請 token；沒設定 → 500（細節不外洩）
    const res = await post({ email: 'acct-nosecret@test.com', tripId: TRIP }, ownerBearer, apiNoSecret);
    expect(res.status).toBe(500);
    const errBody = await res.json();
    expectContract(ApiError, errBody);
    expect((errBody as { error: { code: string; detail?: string } }).error.code).toBe('SYS_INTERNAL');
    expect((errBody as { error: { detail?: string } }).error.detail).toBeUndefined();
  });

  /** 在 TRIP 上新增一個 member 並回傳 permission id。 */
  async function addMember(email: string, role: 'member' | 'viewer' = 'member'): Promise<number> {
    const uid = await seedUser(db, email);
    const row = await db.prepare(`INSERT INTO trip_permissions (trip_id, role, user_id) VALUES (?, ?, ?) RETURNING id`).bind(TRIP, role, uid).first<{ id: number }>();
    return row!.id;
  }
  async function ownerPermId(): Promise<number> {
    const row = await db.prepare(`SELECT id FROM trip_permissions WHERE trip_id = ? AND role = 'owner'`).bind(TRIP).first<{ id: number }>();
    return row!.id;
  }

  it('PATCH → 200 { ok, role }；相同角色 → 200 { ok, unchanged }', async () => {
    const id = await addMember('acct-patch-m@test.com');
    const changed = await hit('/api/permissions/{id}', 'patch', `/api/permissions/${id}`, { bearer: ownerBearer, json: valid(S.Account_PermissionPatchBody, { role: 'viewer' }) });
    expect(changed.status).toBe(200);
    const cb = await changed.json();
    expectContract(S.Account_PermissionUpdated, cb);
    expect(cb).toEqual({ ok: true, role: 'viewer' });
    const same = await api.request('PATCH', `/api/permissions/${id}`, { bearer: ownerBearer, json: { role: 'viewer' } });
    const sb = await same.json();
    expectContract(S.Account_PermissionUpdated, sb);
    expect(sb).toEqual({ ok: true, unchanged: true });
  });

  it('PATCH 400／401／403／404', async () => {
    const id = await addMember('acct-patch-e@test.com');
    const owner = await ownerPermId();
    const patch = (pid: number | string, json: unknown, bearer?: string) => hit('/api/permissions/{id}', 'patch', `/api/permissions/${pid}`, { bearer, json });
    await expectApiError(await patch(id, invalid(S.Account_PermissionPatchBody, { role: 'owner' }), ownerBearer), 400, 'DATA_VALIDATION');
    await expectApiError(await patch(id, {}, ownerBearer), 400, 'DATA_VALIDATION');
    await expectApiError(await patch(id, { role: 'viewer' }), 401);
    await expectApiError(await patch(id, { role: 'viewer' }, strangerBearer), 404, 'DATA_NOT_FOUND'); // 無管理權一律 404（不洩漏存在與否）
    await expectApiError(await patch(owner, { role: 'viewer' }, ownerBearer), 403, 'PERM_DENIED'); // owner 列不可改
    await expectApiError(await patch(999999, { role: 'viewer' }, ownerBearer), 404, 'DATA_NOT_FOUND');
  });

  it('DELETE → 200 { ok }；403（擁有者刪擁有者列）；404（含無管理權）；401', async () => {
    const id = await addMember('acct-del-m@test.com');
    const owner = await ownerPermId();
    const del = (pid: number | string, bearer?: string) => hit('/api/permissions/{id}', 'delete', `/api/permissions/${pid}`, { bearer });
    await expectApiError(await del(id), 401);
    await expectApiError(await del(id, strangerBearer), 404, 'DATA_NOT_FOUND'); // 無管理權一律 404（不洩漏存在與否）
    await expectApiError(await del(owner, ownerBearer), 403, 'PERM_DENIED');
    await expectApiError(await del(999999, ownerBearer), 404, 'DATA_NOT_FOUND');
    const ok = await del(id, ownerBearer);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expectContract(S.Account_Ok, body);
    await expectApiError(await del(id, ownerBearer), 404, 'DATA_NOT_FOUND');
  });
});

// ───────── invitations ─────────

describe('/api/invitations', () => {
  const INV_TRIP = 'acct-inv-trip';
  const INV_OWNER = 'acct-inv-owner@test.com';
  const INVITEE = 'acct-inv-invitee@test.com';
  let ownerB: string;
  let inviteeB: string;
  let n = 0;
  const token = () => `acct-inv-token-${++n}`;

  beforeAll(async () => {
    await seedTrip(db, { id: INV_TRIP, owner: INV_OWNER });
    ownerB = (await sessionFor(db, INV_OWNER)).bearer;
    inviteeB = (await sessionFor(db, INVITEE)).bearer;
  });

  it('GET ?token= → 200 預覽（公開，不需登入）', async () => {
    const t = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: t, invitedEmail: 'acct-preview@test.com', invitedBy: INV_OWNER, role: 'viewer' });
    const res = await hit('/api/invitations', 'get', `/api/invitations?token=${t}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_InvitationPreview, body);
    expect((body as { role: string }).role).toBe('viewer');
  });

  it('GET ?token= 錯誤：400 缺 token；410 無效／已過期／已接受；500 沒設 SESSION_SECRET', async () => {
    await expectApiError(await hit('/api/invitations', 'get', '/api/invitations'), 400, 'INVITATION_TOKEN_MISSING');
    await expectApiError(await hit('/api/invitations', 'get', '/api/invitations?token=never-issued'), 410, 'INVITATION_INVALID');
    const expired = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: expired, invitedEmail: 'acct-exp@test.com', invitedBy: INV_OWNER, expiresAt: '2000-01-01T00:00:00Z' });
    await expectApiError(await hit('/api/invitations', 'get', `/api/invitations?token=${expired}`), 410, 'INVITATION_EXPIRED');
    const accepted = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: accepted, invitedEmail: 'acct-acc@test.com', invitedBy: INV_OWNER, acceptedAt: '2026-01-01T00:00:00Z' });
    await expectApiError(await hit('/api/invitations', 'get', `/api/invitations?token=${accepted}`), 410, 'INVITATION_ACCEPTED');
    await expectApiError(await hit('/api/invitations', 'get', '/api/invitations?token=anything', {}, apiNoSecret), 500, 'SERVER_MISCONFIG');
  });

  it('GET ?tripId= → 200 { items }（owner）；401 未登入；403 非 owner；404 行程不存在', async () => {
    const t = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: t, invitedEmail: 'acct-pending@test.com', invitedBy: INV_OWNER });
    const res = await hit('/api/invitations', 'get', `/api/invitations?tripId=${INV_TRIP}`, { bearer: ownerB });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ invitedEmail: string }> };
    expectContract(S.Account_PendingInvitationList, body);
    expect(body.items.some((i) => i.invitedEmail === 'acct-pending@test.com')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('token_hash');

    await expectApiError(await hit('/api/invitations', 'get', `/api/invitations?tripId=${INV_TRIP}`), 401, 'AUTH_REQUIRED');
    await expectApiError(await hit('/api/invitations', 'get', `/api/invitations?tripId=${INV_TRIP}`, { bearer: inviteeB }), 403, 'PERM_ADMIN_ONLY');
    await expectApiError(await hit('/api/invitations', 'get', '/api/invitations?tripId=no-such-trip', { bearer: ownerB }), 404, 'DATA_NOT_FOUND');
  });

  it('POST /accept → 200；之後再接受 → 410 INVITATION_ACCEPTED', async () => {
    const t = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: t, invitedEmail: INVITEE, invitedBy: INV_OWNER });
    const res = await hit('/api/invitations/accept', 'post', '/api/invitations/accept', { bearer: inviteeB, json: valid(S.Account_InvitationAcceptBody, { token: t }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_InvitationAccepted, body);
    expect(body).toEqual({ ok: true, tripId: INV_TRIP, tripTitle: `Test Trip ${INV_TRIP}` });
    await expectApiError(await hit('/api/invitations/accept', 'post', '/api/invitations/accept', { bearer: inviteeB, json: { token: t } }), 410, 'INVITATION_ACCEPTED');
  });

  it('POST /accept 錯誤：400／401／403（email 不符、受限 token）／410（無效、過期）／500', async () => {
    const accept = (json: unknown, bearer?: string, client: Api = api) => hit('/api/invitations/accept', 'post', '/api/invitations/accept', { bearer, json }, client);
    await expectApiError(await accept(invalid(S.Account_InvitationAcceptBody, {}), inviteeB), 400, 'INVITATION_TOKEN_MISSING');
    await expectApiError(await accept({ token: 'x' }), 401, 'AUTH_REQUIRED');
    const forOther = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: forOther, invitedEmail: 'acct-someone-else@test.com', invitedBy: INV_OWNER });
    await expectApiError(await accept({ token: forOther }, inviteeB), 403, 'INVITATION_EMAIL_MISMATCH');
    await expectApiError(await accept({ token: forOther }, restrictedBearer), 403, 'PERM_DENIED');
    await expectApiError(await accept({ token: 'never-issued' }, inviteeB), 410, 'INVITATION_INVALID');
    const expired = token();
    await seedInvitation(db, { tripId: INV_TRIP, token: expired, invitedEmail: 'acct-exp2@test.com', invitedBy: INV_OWNER, expiresAt: '2000-01-01T00:00:00Z' });
    await expectApiError(await accept({ token: expired }, inviteeB), 410, 'INVITATION_EXPIRED');
    await expectApiError(await accept({ token: 'x' }, inviteeB, apiNoSecret), 500, 'SERVER_MISCONFIG');
  });

  it('POST /revoke → 200 { ok, revoked }；再撤銷 → 404 INVITATION_NOT_FOUND', async () => {
    await seedInvitation(db, { tripId: INV_TRIP, token: token(), invitedEmail: 'acct-revoke@test.com', invitedBy: INV_OWNER });
    const res = await hit('/api/invitations/revoke', 'post', '/api/invitations/revoke', { bearer: ownerB, json: valid(S.Account_InvitationRevokeBody, { tripId: INV_TRIP, email: 'Acct-Revoke@test.com' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectContract(S.Account_InvitationRevoked, body);
    expect(body).toEqual({ ok: true, revoked: 1 });
    await expectApiError(await hit('/api/invitations/revoke', 'post', '/api/invitations/revoke', { bearer: ownerB, json: { tripId: INV_TRIP, email: 'acct-revoke@test.com' } }), 404, 'INVITATION_NOT_FOUND');
  });

  it('POST /revoke 錯誤：400 INVITATION_REVOKE_VALIDATION／401／403 非 owner／404 行程不存在', async () => {
    const revoke = (json: unknown, bearer?: string) => hit('/api/invitations/revoke', 'post', '/api/invitations/revoke', { bearer, json });
    await expectApiError(await revoke(invalid(S.Account_InvitationRevokeBody, { tripId: INV_TRIP }), ownerB), 400, 'INVITATION_REVOKE_VALIDATION');
    await expectApiError(await revoke({ tripId: INV_TRIP, email: 'a@b.com' }), 401, 'AUTH_REQUIRED');
    await expectApiError(await revoke({ tripId: INV_TRIP, email: 'a@b.com' }, inviteeB), 403, 'PERM_ADMIN_ONLY');
    await expectApiError(await revoke({ tripId: 'no-such-trip', email: 'a@b.com' }, ownerB), 404, 'DATA_NOT_FOUND');
  });
});

// ───────── 收尾：文件列出的每個狀態碼都被實際觸發過 ─────────

describe('文件與實際行為一致', () => {
  it('文件列出的每個（路由 × 狀態碼）都至少被真實請求觸發過；觸發過的狀態碼也都有寫進文件', async () => {
    const spec = (await (await createApp().request('/openapi.json')).json()) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> };
    const documented = new Set<string>();
    for (const [method, path] of ROUTES) {
      for (const code of Object.keys(spec.paths[path]?.[method]?.responses ?? {})) documented.add(`${method} ${path} ${code}`);
    }
    const documentedButNeverHit = [...documented].filter((k) => !triggered.has(k));
    const hitButUndocumented = [...triggered].filter((k) => !documented.has(k));
    expect({ documentedButNeverHit, hitButUndocumented }).toEqual({ documentedButNeverHit: [], hitButUndocumented: [] });
  });
});
