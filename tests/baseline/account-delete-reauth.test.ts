// @vitest-environment node
/**
 * 帳號刪除的 fresh-auth（Google 重新驗證）＋ mobile grant 綁定 challenge —— 走 HTTP 邊界。
 * 自舊入口 PR #1458 的 tests/api/account-delete.test.ts（Google 近期重新驗證）與
 * tests/api/account-delete-challenge-states.test.ts 移植。
 *
 * 與舊測試的差異：
 *  - 認證一律用 bearer（sessionFor 發第一方 client 的 AccessToken，含 grantId）；舊的 cookie 流程
 *    （瀏覽器 proof、同 session 綁定、cookie＋Bearer 並存）在新 api 不存在，對應測試移除，新增「非 mobile client 一律 fail-closed」。
 *  - Google 的 token endpoint（global fetch）與 id_token 驗章（會抓 live JWKS）是外部邊界，以 mock 取代；
 *    callback 流程本身（state、nonce、auth_time、帳號比對、challenge 轉換）走真實 handler 與真實 D1。
 *  - state 改存 GoogleLoginState（新 api 的 Google 登入沿用同一張 state 表），多了 nonce 比對與單次使用的測試。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { createMobileDeleteChallenge, readMobileDeleteChallenge } from '../../src/lib/delete-reauth';
import { MOBILE_PROD_REDIRECT } from '../../src/lib/mobile-oauth';
import { hashPassword } from '../../src/lib/password';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor } from './account-session-helper';

const ORIGIN = 'https://x.com';
vi.mock('../../src/lib/oauth-client/google-id-token', () => ({
  verifyGoogleIdToken: vi.fn(async (idToken: string) => JSON.parse(atob(idToken.split('.')[1]!))),
}));
type Status = 'pending' | 'started' | 'verified' | 'failed' | 'cancelled' | 'used';

let db: D1Database;
let api: Api;
beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, {
    ENVIRONMENT: 'production', PUBLIC_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'secret', MOBILE_OAUTH_CALLBACK_URL: MOBILE_PROD_REDIRECT,
  }) });
}, 30000);
afterAll(async () => {
  await db.prepare("DELETE FROM oauth_models WHERE payload LIKE '%rea-u%'").run();
  await db.prepare("DELETE FROM auth_identities WHERE user_id LIKE 'rea-u%'").run();
  await db.prepare("DELETE FROM trips WHERE id LIKE 'rea-trip-%'").run();
  await db.prepare("DELETE FROM users WHERE id LIKE 'rea-u%'").run();
  await disposeMiniflare();
});

let seq = 0;
interface U { id: string; email: string; sub: string; token: string; grantId: string; tokenB: string; grantB: string }
/** 一位 mobile 使用者：google 身分 + 兩個 grant（同一人的兩台裝置）。 */
async function seed(opts: { password?: string; google?: boolean; clientId?: string } = {}): Promise<U> {
  const id = `rea-u${++seq}`;
  const email = `${id}@example.com`;
  await db.prepare("INSERT INTO users (id, email, display_name, status) VALUES (?, ?, ?, 'active')").bind(id, email, id).run();
  const sub = `g-${id}`;
  if (opts.google !== false) await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").bind(id, sub).run();
  if (opts.password) {
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')")
      .bind(id, email, await hashPassword(opts.password)).run();
  }
  const clientId = opts.clientId ?? 'tripline-mobile';
  const a = await sessionFor(db, email, id, { clientId });
  const b = await sessionFor(db, email, id, { clientId });
  return { id, email, sub, token: a.bearer, grantId: a.grantId, tokenB: b.bearer, grantB: b.grantId };
}
async function challengeIn(u: { id: string; grantId: string }, status: Status, opts: { expiresAt?: number; clientId?: string } = {}) {
  const cid = await createMobileDeleteChallenge(db, u.id, u.grantId, opts.clientId ?? 'tripline-mobile');
  await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.status', ?), expires_at = ? WHERE name = 'AccountDeleteChallenge' AND id = ?")
    .bind(status, opts.expiresAt ?? Date.now() + 60_000, cid).run();
  return cid;
}
const statusOf = async (cid: string) => (await readMobileDeleteChallenge(db, cid))?.status;
const userExists = async (id: string) => (await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()) !== null;
const del = (bearer: string, body: object) => api.request('DELETE', `${ORIGIN}/api/account`, { bearer, json: body });
const reauthUrl = (cid?: string) => `${ORIGIN}/api/account/delete-reauth${cid ? `?challenge_id=${cid}` : ''}`;
const cancel = (bearer: string, cid: string) => api.request('DELETE', reauthUrl(cid), { bearer });
const startGoogle = (cid: string, client: Api = api) => client.get(`${ORIGIN}/api/oauth/login/google?purpose=account-delete&challenge=${cid}`);
const errorCode = async (res: Response) => (await res.json() as { error: { code: string } }).error.code;
const nowSec = () => Math.floor(Date.now() / 1000);
const stateOf = (res: Response) => new URL(res.headers.get('Location')!).searchParams.get('state')!;

function idTokenFor(claims: object): string { return `h.${btoa(JSON.stringify(claims))}.s`; }
/** 打 callback：攔 Google 的 token endpoint，回傳我們要的 id_token。nonce 預設取自 state 紀錄（等同 Google 原樣回傳）。 */
async function callback(state: string, claims: Record<string, unknown>, query = 'code=c'): Promise<Response> {
  const row = await db.prepare("SELECT payload FROM oauth_models WHERE name = 'GoogleLoginState' AND id = ?").bind(state).first<{ payload: string }>();
  const nonce = row ? (JSON.parse(row.payload) as { nonce: string }).nonce : 'none';
  const provider = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id_token: idTokenFor({ nonce, ...claims }), access_token: 'a' })));
  try { return await api.get(`${ORIGIN}/api/oauth/callback/google?${query}&state=${state}`); } finally { provider.mockRestore(); }
}
const goodClaims = (u: U) => ({ sub: u.sub, email: u.email, email_verified: true, auth_time: nowSec() });
/** 建立 challenge（POST）並開始 Google 驗證，回傳 challengeId 與 state。 */
async function begin(u: U, bearer = u.token) {
  const started = await api.request('POST', reauthUrl(), { bearer });
  expect(started.status).toBe(200);
  const body = await started.json() as { challengeId: string; authorizeUrl: string; expiresIn: number };
  const google = await api.get(body.authorizeUrl);
  expect(google.status).toBe(302);
  return { ...body, state: stateOf(google), google };
}
/** 驗證完成回到 app 的 Location。 */
const verifiedLocation = (cid: string) => `${MOBILE_PROD_REDIRECT}?challenge_id=${cid}&status=verified`;
const failedLocation = (cid: string) => `${MOBILE_PROD_REDIRECT}?challenge_id=${cid}&status=failed`;
async function expectReauthRequired(res: Response) {
  expect(res.status).toBe(403);
  expect(await errorCode(res)).toBe('ACCOUNT_DELETE_REAUTH_REQUIRED');
}

describe('POST /api/account/delete-reauth：建立 challenge', () => {
  it('回 challengeId、authorizeUrl、expiresIn=300，no-store；challenge 綁 uid／grant／client，5 分鐘 TTL', async () => {
    const u = await seed();
    const before = Date.now();
    const res = await api.request('POST', reauthUrl(), { bearer: u.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json() as { challengeId: string; authorizeUrl: string; expiresIn: number };
    expect(body.expiresIn).toBe(300);
    expect(body.authorizeUrl).toBe(`${ORIGIN}/api/oauth/login/google?purpose=account-delete&challenge=${body.challengeId}`);
    const row = await db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND id = ?")
      .bind(body.challengeId).first<{ payload: string; expires_at: number }>();
    expect(JSON.parse(row!.payload)).toEqual({ uid: u.id, grantId: u.grantId, clientId: 'tripline-mobile', status: 'pending', surface: 'mobile' });
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + 300_000);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('沒有 Google 身分的帳號 → 403 ACCOUNT_DELETE_REAUTH_REQUIRED，不建立 challenge', async () => {
    const u = await seed({ google: false });
    await expectReauthRequired(await api.request('POST', reauthUrl(), { bearer: u.token }));
    const n = await db.prepare("SELECT count(*) AS n FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND json_extract(payload, '$.uid') = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('未登入 → 401；非 mobile 非 web 的 client、受限 token、環境不符的 mobile client → 403 PERM_DENIED', async () => {
    expect((await api.request('POST', reauthUrl())).status).toBe(401);
    const web = await seed({ clientId: 'tripline-tp-request' });
    const r1 = await api.request('POST', reauthUrl(), { bearer: web.token });
    expect(r1.status).toBe(403);
    expect(await errorCode(r1)).toBe('PERM_DENIED');
    const uat = await seed({ clientId: 'tripline-mobile-uat' }); // production 環境不認 UAT client
    expect(await errorCode(await api.request('POST', reauthUrl(), { bearer: uat.token }))).toBe('PERM_DENIED');
    const u = await seed();
    const restricted = (await sessionFor(db, u.email, u.id, { clientId: 'tripline-mobile', restrictTrip: 'some-trip' })).bearer;
    expect(await errorCode(await api.request('POST', reauthUrl(), { bearer: restricted }))).toBe('PERM_DENIED');
  });

  it('MOBILE_OAUTH_CALLBACK_URL 未設定或與環境契約不符 → 500 SERVER_MISCONFIG', async () => {
    const u = await seed();
    for (const url of [undefined, 'https://evil.example/cb']) {
      const misconfigured = createApi({ env: mockEnv(db, { ENVIRONMENT: 'production', PUBLIC_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 's', ...(url ? { MOBILE_OAUTH_CALLBACK_URL: url } : {}) }) });
      const res = await misconfigured.request('POST', reauthUrl(), { bearer: u.token });
      expect(res.status).toBe(500);
      expect(await errorCode(res)).toBe('SERVER_MISCONFIG');
    }
  });
});

describe('GET／DELETE /api/account/delete-reauth：查狀態、取消', () => {
  it('challenge 綁 grant：可查狀態並取消；同一個使用者別的 grant、別的使用者都讀不到（404）', async () => {
    const u = await seed(); const other = await seed();
    const started = await (await api.request('POST', reauthUrl(), { bearer: u.token })).json() as { challengeId: string };
    for (const bearer of [u.tokenB, other.token]) {
      const res = await api.get(reauthUrl(started.challengeId), { bearer });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('DATA_NOT_FOUND');
      expect((await cancel(bearer, started.challengeId)).status, '別人也不能取消').toBe(404);
    }
    const mine = await api.get(reauthUrl(started.challengeId), { bearer: u.token });
    expect(mine.headers.get('Cache-Control')).toBe('no-store');
    expect(await mine.json()).toEqual({ status: 'pending' });
    expect((await cancel(u.token, started.challengeId)).status).toBe(200);
    expect(await (await api.get(reauthUrl(started.challengeId), { bearer: u.token })).json()).toEqual({ status: 'cancelled' });
  });

  it('沒帶 challenge_id → 400 DATA_VALIDATION；非 mobile 非 web client → 403 PERM_DENIED；未登入 → 401', async () => {
    const u = await seed();
    const noId = await api.get(reauthUrl(), { bearer: u.token });
    expect(noId.status).toBe(400);
    expect(await errorCode(noId)).toBe('DATA_VALIDATION');
    const web = await seed({ clientId: 'tripline-tp-request' });
    expect((await api.get(reauthUrl('x'), { bearer: web.token })).status).toBe(403);
    expect((await api.get(reauthUrl('x'))).status).toBe(401);
    expect((await cancel(u.token, '')).status).toBe(400);
  });

  it('過期的 challenge：GET 回 { status: expired, expiresIn: 0 }；DELETE → 403 ACCOUNT_DELETE_REAUTH_REQUIRED', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending', { expiresAt: Date.now() - 1000 });
    expect(await (await api.get(reauthUrl(cid), { bearer: u.token })).json()).toEqual({ status: 'expired', expiresIn: 0 });
    await expectReauthRequired(await cancel(u.token, cid));
  });

  it.each(['pending', 'started', 'verified'] as const)('%s → cancelled，之後不能再被消耗', async (status) => {
    const u = await seed();
    const cid = await challengeIn(u, status);
    expect((await cancel(u.token, cid)).status).toBe(200);
    expect(await statusOf(cid)).toBe('cancelled');
    expect(await (await cancel(u.token, cid)).json(), '重複取消冪等').toEqual({ status: 'cancelled' });
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId: cid }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('failed 的 challenge 取消 → 200（冪等的清理，不回錯），狀態仍是 failed', async () => {
    // callback 把 challenge 標成 failed 後，app 通常會再送一次取消來收尾；這不該得到 409
    const u = await seed();
    const cid = await challengeIn(u, 'failed');
    const res = await cancel(u.token, cid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'failed' });
    expect(await statusOf(cid)).toBe('failed');
  });

  it('used 不能取消（409 DATA_CONFLICT），狀態不被改寫', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'used');
    const refused = await cancel(u.token, cid);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe('DATA_CONFLICT');
    expect(await statusOf(cid)).toBe('used');
  });
});

describe('DELETE /api/account：mobile challenge 只有 verified 才能消耗', () => {
  it.each(['pending', 'started', 'failed', 'cancelled', 'used'] as const)('status=%s 被拒，帳號與 challenge 不變', async (status) => {
    const u = await seed();
    const cid = await challengeIn(u, status);
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId: cid }));
    expect(await userExists(u.id)).toBe(true);
    expect(await statusOf(cid)).toBe(status);
  });

  it('已過期的 verified 被拒', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'verified', { expiresAt: Date.now() - 1000 });
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId: cid }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('別人的 challenge、同帳號別的 grant、缺 challengeId、不存在的 challengeId、與環境不符的 client 都被拒', async () => {
    const a = await seed(); const b = await seed();
    const bChallenge = await challengeIn(b, 'verified');
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId: bChallenge }));
    const aChallenge = await challengeIn(a, 'verified');
    await expectReauthRequired(await del(a.tokenB, { confirm: 'DELETE', challengeId: aChallenge })); // 同一人、另一個 grant
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE' }));
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId: 'does-not-exist' }));
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId: 42 }));
    const uatChallenge = await challengeIn(a, 'verified', { clientId: 'tripline-mobile-uat' }); // production 環境不認 UAT client
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId: uatChallenge }));
    expect(await userExists(a.id) && await userExists(b.id)).toBe(true);
    expect(await statusOf(bChallenge)).toBe('verified');
    expect(await statusOf(aChallenge)).toBe('verified');
  });

  it('challenge 的 uid 與呼叫者不同（即使 grant 相同）也被拒；uid 相同但 grant 不同也被拒', async () => {
    const a = await seed(); const b = await seed();
    const wrongUid = await challengeIn({ id: b.id, grantId: a.grantId }, 'verified'); // uid=b、grant=a 的 grant
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId: wrongUid }));
    const wrongGrant = await challengeIn({ id: a.id, grantId: a.grantB }, 'verified'); // uid=a、grant=a 的另一個 grant
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId: wrongGrant }));
    expect(await userExists(a.id) && await userExists(b.id)).toBe(true);
    expect([await statusOf(wrongUid), await statusOf(wrongGrant)]).toEqual(['verified', 'verified']);
  });

  it('web client 拿 mobile surface（含舊紀錄）的 verified challenge 也刪不掉（web 路徑見 account-delete-reauth-web.test.ts）', async () => {
    const web = await seed({ clientId: 'tripline-web' });
    const mobile = await seed();
    const cid = await challengeIn(mobile, 'verified');
    await expectReauthRequired(await del(web.token, { confirm: 'DELETE', challengeId: cid }));
    const own = await challengeIn(web, 'verified', { clientId: 'tripline-web' }); // createMobileDeleteChallenge 預設 surface=mobile
    await expectReauthRequired(await del(web.token, { confirm: 'DELETE', challengeId: own }));
    expect(await userExists(web.id)).toBe(true);
    expect(await statusOf(own)).toBe('verified');
  });

  it('有密碼帳號維持密碼二次確認：不需要 challenge；帶了 challenge 也不會被消耗', async () => {
    const u = await seed({ password: 'correct-horse-battery' });
    const cid = await challengeIn(u, 'verified');
    expect((await del(u.token, { password: 'wrong', challengeId: cid })).status).toBe(401);
    expect(await statusOf(cid)).toBe('verified');
    expect((await del(u.token, { password: 'correct-horse-battery' })).status).toBe(200);
    expect(await userExists(u.id)).toBe(false);
  });

  it('兩個並行 DELETE 打同一個 verified challenge：只有一個成功', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'verified');
    const results = await Promise.all([del(u.token, { confirm: 'DELETE', challengeId: cid }), del(u.token, { confirm: 'DELETE', challengeId: cid })]);
    expect(results.map((r) => r.status).sort(), '一個 200、另一個 403').toEqual([200, 403]);
    expect(await userExists(u.id)).toBe(false);
  });

  it('成功：回摘要；該使用者所有 grant 的 token 與 challenge 都撤銷，別人的不動', async () => {
    const u = await seed(); const other = await seed();
    await db.prepare(`INSERT INTO trips (id, name, owner_user_id, published) VALUES ('rea-trip-1', 't', ?, 1)`).bind(u.id).run();
    await db.prepare(`INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('Consent', ?, ?, ?)`)
      .bind(`${u.id}:app`, JSON.stringify({ user_id: u.id, client_id: 'app', scopes: [] }), Date.now() + 60000).run();
    const otherChallenge = await challengeIn(other, 'verified');
    const cid = await challengeIn(u, 'verified');
    const leftover = await challengeIn(u, 'pending'); // 同一人另一個進行中的 challenge（$.uid）
    const res = await del(u.token, { confirm: 'DELETE', challengeId: cid });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tripsDeleted: 1 });
    const mine = await db.prepare(`SELECT count(*) AS n FROM oauth_models WHERE json_extract(payload, '$.user_id') = ? OR json_extract(payload, '$.uid') = ?`).bind(u.id, u.id).first<{ n: number }>();
    expect(mine!.n, 'token（兩個 grant 的 access+refresh）、Consent、challenge 全清').toBe(0);
    expect(await statusOf(leftover)).toBeUndefined();
    expect(await statusOf(otherChallenge), '別人的 challenge 不動').toBe('verified');
    expect((await api.get(`${ORIGIN}/api/account`, { bearer: u.tokenB })).status, '另一個 grant 的 token 也立即失效').toBe(401);
    expect((await api.get(`${ORIGIN}/api/account`, { bearer: other.token })).status).toBe(200);
  });

  it('抹除失敗：整批回滾（行程與 token 都還在），challenge 從 used 還原成 verified，同一個 challenge 可重試', async () => {
    const u = await seed();
    await db.prepare(`INSERT INTO trips (id, name, owner_user_id, published) VALUES ('rea-trip-2', 't', ?, 1)`).bind(u.id).run();
    const cid = await challengeIn(u, 'verified');
    const trigger = `rea_fail_${u.id.replace(/-/g, '_')}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE DELETE ON users
      WHEN OLD.id = '${u.id}' BEGIN SELECT RAISE(ABORT, 'simulated erasure failure'); END`).run();
    expect((await del(u.token, { confirm: 'DELETE', challengeId: cid })).status, '抹除失敗要回錯誤').toBeGreaterThanOrEqual(500);
    expect(await userExists(u.id)).toBe(true);
    expect(await db.prepare("SELECT id FROM trips WHERE id = 'rea-trip-2'").first(), '行程不得被刪到一半').not.toBeNull();
    expect((await api.get(`${ORIGIN}/api/account`, { bearer: u.token })).status, 'token 不得被刪到一半').toBe(200);
    expect(await statusOf(cid)).toBe('verified');
    await db.prepare(`DROP TRIGGER ${trigger}`).run();
    expect((await del(u.token, { confirm: 'DELETE', challengeId: cid })).status).toBe(200);
    expect(await userExists(u.id)).toBe(false);
  });
});

describe('GET /api/oauth/login/google?purpose=account-delete', () => {
  it('302 到 Google：帶 prompt=select_account、max_age=0、claims auth_time、PKCE；state 存 5 分鐘、綁 challenge；challenge 轉 started', async () => {
    const u = await seed();
    const before = Date.now();
    const { challengeId, google, state } = await begin(u);
    const loc = new URL(google.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('prompt')).toBe('select_account');
    expect(loc.searchParams.get('max_age')).toBe('0');
    expect(JSON.parse(loc.searchParams.get('claims')!)).toEqual({ id_token: { auth_time: { essential: true } } });
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/oauth/callback/google`);
    expect(google.headers.get('Set-Cookie')).toBeNull();
    const row = await db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'GoogleLoginState' AND id = ?").bind(state).first<{ payload: string; expires_at: number }>();
    const payload = JSON.parse(row!.payload);
    expect(payload.reauth).toEqual({ uid: u.id, challengeId, grantId: u.grantId, clientId: 'tripline-mobile', surface: 'mobile' });
    expect(payload.redirect_uri).toBe(MOBILE_PROD_REDIRECT);
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + 300_000);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(await statusOf(challengeId)).toBe('started');
  });

  it('沒帶 challenge、challenge 不存在、已過期 → 403 ACCOUNT_DELETE_REAUTH_REQUIRED（JSON）', async () => {
    const u = await seed();
    await expectReauthRequired(await api.get(`${ORIGIN}/api/oauth/login/google?purpose=account-delete`));
    await expectReauthRequired(await startGoogle('does-not-exist'));
    const expired = await challengeIn(u, 'pending', { expiresAt: Date.now() - 1000 });
    await expectReauthRequired(await startGoogle(expired));
  });

  it('Google 沒設定 → 503（先於 challenge 檢查）', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending');
    const unconfigured = createApi({ env: mockEnv(db, { ENVIRONMENT: 'production', PUBLIC_ORIGIN: ORIGIN }) });
    expect((await startGoogle(cid, unconfigured)).status).toBe(503);
    expect(await statusOf(cid)).toBe('pending');
  });

  it.each(['verified', 'failed', 'cancelled', 'used'] as const)('status=%s 被拒（403），狀態不變', async (status) => {
    const u = await seed();
    const cid = await challengeIn(u, status);
    expect((await startGoogle(cid)).status).toBe(403);
    expect(await statusOf(cid)).toBe(status);
  });

  it('與環境不符的 client（production 不認 UAT client）不能開始驗證，狀態仍是 pending', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending', { clientId: 'tripline-mobile-uat' });
    expect((await startGoogle(cid)).status).toBe(403);
    expect(await statusOf(cid)).toBe('pending');
  });

  it('同一個 challenge 開始兩次：第二次也能開始（重新整理、預讀不會卡死），狀態維持 started', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending');
    expect((await startGoogle(cid)).status).toBe(302);
    expect(await statusOf(cid)).toBe('started');
    expect((await startGoogle(cid)).status).toBe(302);
    expect(await statusOf(cid)).toBe('started');
  });

  it('兩個並行的開始請求（預讀加上使用者點擊）都成功，challenge 是 started', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending');
    const [a, b] = await Promise.all([startGoogle(cid), startGoogle(cid)]);
    expect([a.status, b.status]).toEqual([302, 302]);
    expect(await statusOf(cid)).toBe('started');
  });

  it('已是 started 時，第二次開始的 state 寫入失敗：不得把別人進行中的流程降回 pending', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending');
    expect((await startGoogle(cid)).status).toBe(302);
    const broken = vi.spyOn(D1Adapter.prototype, 'upsert').mockRejectedValueOnce(new Error('d1 write failed'));
    try {
      expect((await startGoogle(cid)).status).toBeGreaterThanOrEqual(500);
    } finally { broken.mockRestore(); }
    expect(await statusOf(cid), '第一次開始的流程還在進行，不能被第二次的失敗還原').toBe('started');
  });

  it('開始驗證時 state 寫入失敗：challenge 還原成 pending，使用者可立即重試', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending');
    const broken = vi.spyOn(D1Adapter.prototype, 'upsert').mockRejectedValueOnce(new Error('d1 write failed'));
    try {
      expect((await startGoogle(cid)).status, 'state 寫入失敗要回錯誤').toBeGreaterThanOrEqual(500);
    } finally { broken.mockRestore(); }
    expect(await statusOf(cid)).toBe('pending');
    expect((await startGoogle(cid)).status).toBe(302);
  });
});

describe('GET /api/oauth/callback/google：重新驗證分支', () => {
  it('同帳號完成近期 Google 驗證 → challenge verified，302 回 app；不建 session／code、不動 identity，只准同 grant 刪除一次', async () => {
    const u = await seed();
    const lastUsedBefore = await db.prepare("SELECT last_used_at FROM auth_identities WHERE user_id = ? AND provider = 'google'").bind(u.id).first();
    const { challengeId, state } = await begin(u);
    const done = await callback(state, goodClaims(u));
    expect(done.status).toBe(302);
    expect(done.headers.get('Location')).toBe(verifiedLocation(challengeId));
    expect(done.headers.get('Set-Cookie'), '重新驗證不得換發 session').toBeNull();
    expect(await db.prepare("SELECT 1 FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.user_id') = ?").bind(u.id).first(), '不得發 authorization code').toBeNull();
    expect(await db.prepare("SELECT last_used_at FROM auth_identities WHERE user_id = ? AND provider = 'google'").bind(u.id).first()).toEqual(lastUsedBefore);
    expect(await (await api.get(reauthUrl(challengeId), { bearer: u.token })).json()).toEqual({ status: 'verified' });

    await expectReauthRequired(await del(u.tokenB, { confirm: 'DELETE', challengeId })); // 同一人的另一個 grant 不行
    expect((await del(u.token, { confirm: 'DELETE', challengeId })).status).toBe(200);
    expect(await userExists(u.id)).toBe(false);
  });

  it('使用者拒絕 Google 驗證（error=access_denied）→ failed，帳號不動；取消收尾仍是 200', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    const denied = await api.get(`${ORIGIN}/api/oauth/callback/google?error=access_denied&state=${state}`);
    expect(denied.headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await (await api.get(reauthUrl(challengeId), { bearer: u.token })).json()).toEqual({ status: 'failed' });
    expect((await cancel(u.token, challengeId)).status).toBe(200);
    expect(await userExists(u.id)).toBe(true);
  });

  it('沒有 code 也沒有 error → failed', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect((await api.get(`${ORIGIN}/api/oauth/callback/google?state=${state}`)).headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await statusOf(challengeId)).toBe('failed');
  });

  it.each([
    ['另一個 Google 帳號', 'different-sub', 0],
    ['不是近期驗證（10 分鐘前）', 'own', -600],
    ['未來的驗證時間', 'own', 600],
  ])('%s 不得取得刪除授權', async (_case, who, skew) => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    const done = await callback(state, { ...goodClaims(u), sub: who === 'own' ? u.sub : who, auth_time: nowSec() + skew });
    expect(done.status).toBe(302);
    expect(done.headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await statusOf(challengeId)).toBe('failed');
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('auth_time 超過 5 分鐘（即使晚於這次驗證開始）→ failed：新鮮度本身有獨立判定，不只靠 state 逾時', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    // state 仍在有效期內，但開始時間早於 10 分鐘前；auth_time 為 9 分鐘前（晚於開始時間，所以「不早於開始」那條擋不住）
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.created_at', ?) WHERE name = 'GoogleLoginState' AND id = ?").bind(Date.now() - 600_000, state).run();
    expect((await callback(state, { ...goodClaims(u), auth_time: nowSec() - 540 })).headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await statusOf(challengeId)).toBe('failed');
  });

  it('auth_time 缺少或不是數字 → failed', async () => {
    for (const authTime of [undefined, 'yesterday', null]) {
      const u = await seed();
      const { challengeId, state } = await begin(u);
      const claims: Record<string, unknown> = { ...goodClaims(u), auth_time: authTime };
      if (authTime === undefined) delete claims.auth_time;
      expect((await callback(state, claims)).headers.get('Location')).toBe(failedLocation(challengeId));
      expect(await statusOf(challengeId)).toBe('failed');
    }
  });

  it('auth_time 早於這次驗證開始（重放舊的 Google 登入結果）→ failed', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    // 開始時間往後推 1 分鐘，等同 auth_time 在開始之前
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.created_at', ?) WHERE name = 'GoogleLoginState' AND id = ?").bind(Date.now() + 60_000, state).run();
    expect((await callback(state, goodClaims(u))).headers.get('Location')).toBe(failedLocation(challengeId));
  });

  it('nonce 不符（id_token 被替換）→ failed', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect((await callback(state, { ...goodClaims(u), nonce: 'someone-elses-nonce' })).headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await statusOf(challengeId)).toBe('failed');
  });

  it('Google token endpoint 失敗／網路錯誤／回非 JSON → failed，帳號不動', async () => {
    for (const impl of [
      () => Promise.resolve(new Response('boom', { status: 500 })),
      () => Promise.reject(new Error('network down')),
      () => Promise.resolve(new Response('not json', { status: 200 })),
    ]) {
      const u = await seed();
      const { challengeId, state } = await begin(u);
      const provider = vi.spyOn(global, 'fetch').mockImplementation(impl);
      try {
        expect((await api.get(`${ORIGIN}/api/oauth/callback/google?code=c&state=${state}`)).headers.get('Location')).toBe(failedLocation(challengeId));
      } finally { provider.mockRestore(); }
      expect(await statusOf(challengeId)).toBe('failed');
      expect(await userExists(u.id)).toBe(true);
    }
  });

  it('state 單次使用：重放同一個 callback → 400 OAUTH_INVALID_STATE，不改變 verified', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect((await callback(state, goodClaims(u))).headers.get('Location')).toBe(verifiedLocation(challengeId));
    const replay = await callback(state, goodClaims(u));
    expect(replay.status).toBe(400);
    expect(await errorCode(replay)).toBe('OAUTH_INVALID_STATE');
    expect(await statusOf(challengeId)).toBe('verified');
  });

  it('state 逾時（5 分鐘）→ 400 OAUTH_INVALID_STATE，challenge 仍是 started、不能刪帳號', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    await db.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'GoogleLoginState' AND id = ?").bind(Date.now() - 1000, state).run();
    const late = await callback(state, goodClaims(u));
    expect(late.status).toBe(400);
    expect(await errorCode(late)).toBe('OAUTH_INVALID_STATE');
    expect(await statusOf(challengeId)).toBe('started');
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId }));
  });

  it('challenge 在 Google 往返中過期 → failed（不是 verified）', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    await db.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(Date.now() - 1000, challengeId).run();
    expect((await callback(state, goodClaims(u))).headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await userExists(u.id)).toBe(true);
  });

  it('跨帳號：B 的 Google 身分完成 A 的 challenge → failed，A 與 B 都不能刪', async () => {
    const a = await seed(); const b = await seed();
    const { challengeId, state } = await begin(a);
    const done = await callback(state, goodClaims(b));
    expect(done.headers.get('Location')).toBe(failedLocation(challengeId));
    await expectReauthRequired(await del(a.token, { confirm: 'DELETE', challengeId }));
    await expectReauthRequired(await del(b.token, { confirm: 'DELETE', challengeId }));
    expect(await userExists(a.id) && await userExists(b.id)).toBe(true);
  });

  it('開始兩次產生兩個 state：兩個都完成時只有第一個能讓 challenge 變 verified，第二個不會把它降級', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending');
    const [s1, s2] = [stateOf(await startGoogle(cid)), stateOf(await startGoogle(cid))];
    expect((await callback(s1, goodClaims(u))).headers.get('Location')).toBe(verifiedLocation(cid));
    await callback(s2, goodClaims(u));
    expect(await statusOf(cid), '第二個 state 不得把已 verified 的 challenge 降級').toBe('verified');
    expect((await del(u.token, { confirm: 'DELETE', challengeId: cid })).status).toBe(200); // 仍能用那一次 verified 刪除
    expect(await userExists(u.id)).toBe(false);
  });

  it('started 時被取消，之後 Google 回來（驗證成功）也只會得到 failed，challenge 維持 cancelled 且不能刪帳號', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect((await cancel(u.token, challengeId)).status).toBe(200);
    expect((await callback(state, goodClaims(u))).headers.get('Location')).toBe(failedLocation(challengeId));
    expect(await statusOf(challengeId)).toBe('cancelled');
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('state 帶的 client 與環境不符（例如跨環境搬來的 state）→ 沒有可導回的 challenge，回 403 JSON，不轉 verified', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.reauth.clientId', 'tripline-mobile-uat') WHERE name = 'GoogleLoginState' AND id = ?").bind(state).run();
    const done = await callback(state, goodClaims(u));
    await expectReauthRequired(done);
    expect(await statusOf(challengeId)).toBe('started');
  });
});

describe('既有的 Google 登入不受影響', () => {
  it('不帶 purpose 的 login/google 仍走一般登入驗證（缺 client_id → 400，不是 403）', async () => {
    const res = await api.get(`${ORIGIN}/api/oauth/login/google`);
    expect(res.status).toBe(400);
  });
});
