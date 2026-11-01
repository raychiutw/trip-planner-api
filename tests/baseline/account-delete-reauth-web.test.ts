// @vitest-environment node
/**
 * 帳號刪除的 fresh-auth —— web（tripline-web）無密碼帳號路徑，走 HTTP 邊界。
 * 與 account-delete-reauth.test.ts（mobile）共用同一套 challenge 狀態機，差別在 challenge 的 surface='web'，
 * 以及 Google 驗證後導回「由 server 組成的固定網址」`${WEB_ORIGIN}/account?deleteReauth=done|failed`。
 *
 * Google 的 token endpoint 與 id_token 驗章是外部邊界，以 mock 取代（手法同 mobile 測試）；其餘走真實 handler 與真實 D1。
 * challenge 紀錄一律以 SQL 直接寫入，不依賴實作的 helper 簽章。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Env } from '../../src/env';
import { hashPassword } from '../../src/lib/password';
import { requireAccountActor } from '../../src/lib/delete-reauth';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor } from './account-session-helper';

const ORIGIN = 'https://x.com';
const WEB = 'https://web.example';
vi.mock('../../src/lib/oauth-client/google-id-token', () => ({
  verifyGoogleIdToken: vi.fn(async (idToken: string) => JSON.parse(atob(idToken.split('.')[1]!))),
}));
type Status = 'pending' | 'started' | 'verified' | 'failed' | 'cancelled' | 'used';

const baseEnv: Partial<Env> = {
  ENVIRONMENT: 'production', PUBLIC_ORIGIN: ORIGIN, WEB_ORIGIN: WEB, ALLOWED_ORIGINS: WEB,
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'secret', MOBILE_OAUTH_CALLBACK_URL: 'https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback',
};
let db: D1Database;
let api: Api;
beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, baseEnv) });
}, 30000);
afterAll(async () => {
  await db.prepare("DELETE FROM oauth_models WHERE payload LIKE '%wre-u%'").run();
  await db.prepare("DELETE FROM auth_identities WHERE user_id LIKE 'wre-u%'").run();
  await db.prepare("DELETE FROM users WHERE id LIKE 'wre-u%'").run();
  await disposeMiniflare();
});

let seq = 0;
interface U { id: string; email: string; sub: string; token: string; grantId: string; tokenB: string; grantB: string }
async function seed(opts: { password?: string; google?: boolean; clientId?: string } = {}): Promise<U> {
  const id = `wre-u${++seq}`;
  const email = `${id}@example.com`;
  await db.prepare("INSERT INTO users (id, email, display_name, status) VALUES (?, ?, ?, 'active')").bind(id, email, id).run();
  const sub = `g-${id}`;
  if (opts.google !== false) await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").bind(id, sub).run();
  if (opts.password) {
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')")
      .bind(id, email, await hashPassword(opts.password)).run();
  }
  const clientId = opts.clientId ?? 'tripline-web';
  const a = await sessionFor(db, email, id, { clientId });
  const b = await sessionFor(db, email, id, { clientId });
  return { id, email, sub, token: a.bearer, grantId: a.grantId, tokenB: b.bearer, grantB: b.grantId };
}
/** 直接寫入 challenge。surface 省略＝舊紀錄（沒有此欄）。 */
async function challengeIn(u: { id: string; grantId: string }, status: Status,
  opts: { expiresAt?: number; clientId?: string; surface?: 'web' | 'mobile' | null } = {}) {
  const id = `wre-ch-${crypto.randomUUID()}`;
  const surface = opts.surface === undefined ? 'web' : opts.surface;
  const payload = { uid: u.id, grantId: u.grantId, clientId: opts.clientId ?? 'tripline-web', status, ...(surface ? { surface } : {}) };
  await db.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)')
    .bind('AccountDeleteChallenge', id, JSON.stringify(payload), opts.expiresAt ?? Date.now() + 60_000).run();
  return id;
}
const rowOf = async (cid: string) => {
  const r = await db.prepare("SELECT payload FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(cid).first<{ payload: string }>();
  return r ? JSON.parse(r.payload) as { status: Status; surface?: string; clientId: string } : null;
};
const statusOf = async (cid: string) => (await rowOf(cid))?.status;
const userExists = async (id: string) => (await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()) !== null;
const H = { Origin: WEB };
const del = (bearer: string, body: object, client: Api = api) => client.request('DELETE', `${ORIGIN}/api/account`, { bearer, json: body, headers: H });
const reauthUrl = (cid?: string) => `${ORIGIN}/api/account/delete-reauth${cid ? `?challenge_id=${cid}` : ''}`;
const post = (bearer: string, client: Api = api) => client.request('POST', reauthUrl(), { bearer, headers: H });
const cancel = (bearer: string, cid: string) => api.request('DELETE', reauthUrl(cid), { bearer, headers: H });
const errorCode = async (res: Response) => (await res.json() as { error: { code: string } }).error.code;
const nowSec = () => Math.floor(Date.now() / 1000);
const stateOf = (res: Response) => new URL(res.headers.get('Location')!).searchParams.get('state')!;
const idTokenFor = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`;
async function callback(state: string, claims: Record<string, unknown>, query = 'code=c', client: Api = api): Promise<Response> {
  const row = await db.prepare("SELECT payload FROM oauth_models WHERE name = 'GoogleLoginState' AND id = ?").bind(state).first<{ payload: string }>();
  const nonce = row ? (JSON.parse(row.payload) as { nonce: string }).nonce : 'none';
  const provider = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id_token: idTokenFor({ nonce, ...claims }), access_token: 'a' })));
  try { return await client.get(`${ORIGIN}/api/oauth/callback/google?${query}&state=${state}`); } finally { provider.mockRestore(); }
}
const goodClaims = (u: U) => ({ sub: u.sub, email: u.email, email_verified: true, auth_time: nowSec() });
const DONE = `${WEB}/account?deleteReauth=done`;
const FAILED = `${WEB}/account?deleteReauth=failed`;
async function begin(u: U, bearer = u.token) {
  const started = await post(bearer);
  expect(started.status).toBe(200);
  const body = await started.json() as { challengeId: string; authorizeUrl: string; expiresIn: number };
  const google = await api.get(body.authorizeUrl);
  expect(google.status).toBe(302);
  return { ...body, state: stateOf(google), google };
}
async function expectReauthRequired(res: Response) {
  expect(res.status).toBe(403);
  expect(await errorCode(res)).toBe('ACCOUNT_DELETE_REAUTH_REQUIRED');
}
const previewOf = async (bearer: string) => (await (await api.get(`${ORIGIN}/api/account`, { bearer, headers: H })).json()) as { hasPassword: boolean; reauthProvider: string | null; reauthenticated: boolean };

describe('POST /api/account/delete-reauth：web 呼叫者', () => {
  it('回 challengeId／authorizeUrl／expiresIn=300；challenge 綁 uid／grant／tripline-web，surface=web', async () => {
    const u = await seed();
    const res = await post(u.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json() as { challengeId: string; authorizeUrl: string; expiresIn: number };
    expect(body.expiresIn).toBe(300);
    expect(body.authorizeUrl).toBe(`${ORIGIN}/api/oauth/login/google?purpose=account-delete&challenge=${body.challengeId}`);
    expect(await rowOf(body.challengeId)).toEqual({ uid: u.id, grantId: u.grantId, clientId: 'tripline-web', status: 'pending', surface: 'web' });
  });

  it('沒帶 Origin（非瀏覽器呼叫）也可建立', async () => {
    const u = await seed();
    expect((await api.request('POST', reauthUrl(), { bearer: u.token })).status).toBe(200);
  });

  it('沒有 Google 身分的帳號 → 403 ACCOUNT_DELETE_REAUTH_REQUIRED，不建立 challenge', async () => {
    const u = await seed({ google: false });
    await expectReauthRequired(await post(u.token));
    const n = await db.prepare("SELECT count(*) AS n FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND json_extract(payload, '$.uid') = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('非 web 非 mobile 的 client（tripline-tp-request）、受限 token → 403 PERM_DENIED，三條路由皆然', async () => {
    const other = await seed({ clientId: 'tripline-tp-request' });
    for (const [m, url] of [['POST', reauthUrl()], ['GET', reauthUrl('x')], ['DELETE', reauthUrl('x')]] as const) {
      const res = await api.request(m, url, { bearer: other.token });
      expect(res.status, `${m}`).toBe(403);
      expect(await errorCode(res)).toBe('PERM_DENIED');
    }
    const u = await seed();
    const restricted = (await sessionFor(db, u.email, u.id, { clientId: 'tripline-web', restrictTrip: 'some-trip' })).bearer;
    expect(await errorCode(await post(restricted))).toBe('PERM_DENIED');
    expect((await api.request('POST', reauthUrl())).status).toBe(401);
  });

  it('WEB_ORIGIN 設定無效（http、帶 path／query、都沒設）→ 500 SERVER_MISCONFIG，不建立 challenge；缺省用 PUBLIC_ORIGIN', async () => {
    const u = await seed();
    for (const bad of ['http://web.example', 'https://web.example/app', 'https://web.example?x=1', 'https://user:pw@web.example']) {
      const misconfigured = createApi({ env: mockEnv(db, { ...baseEnv, WEB_ORIGIN: bad }) });
      const res = await post(u.token, misconfigured);
      expect(res.status, bad).toBe(500);
      expect(await errorCode(res)).toBe('SERVER_MISCONFIG');
    }
    const neither = createApi({ env: mockEnv(db, { ...baseEnv, WEB_ORIGIN: undefined, PUBLIC_ORIGIN: undefined }) });
    expect((await post(u.token, neither)).status).toBe(500);
    const n = await db.prepare("SELECT count(*) AS n FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND json_extract(payload, '$.uid') = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
    const fallback = createApi({ env: mockEnv(db, { ...baseEnv, WEB_ORIGIN: undefined }) });
    const { challengeId } = await (await post(u.token, fallback)).json() as { challengeId: string };
    const google = await fallback.get(`${ORIGIN}/api/oauth/login/google?purpose=account-delete&challenge=${challengeId}`);
    const done = await callback(stateOf(google), goodClaims(u), 'code=c', fallback);
    expect(done.headers.get('Location')).toBe(`${ORIGIN}/account?deleteReauth=done`);
  });
});

describe('requireAccountActor：web 條件', () => {
  const ctx = (auth: object | null, origin?: string, env: object = baseEnv) => ({
    data: { auth }, env: mockEnv(db, env), request: new Request(`${ORIGIN}/api/account/delete-reauth`, origin ? { headers: { Origin: origin } } : {}),
  });
  const webAuth = { userId: 'u', grantId: 'g', clientId: 'tripline-web', isServiceToken: false };
  it('合格的 web 回 surface=web', () => {
    expect(requireAccountActor(ctx(webAuth, WEB) as never)).toEqual({ uid: 'u', grantId: 'g', clientId: 'tripline-web', surface: 'web' });
    expect(requireAccountActor(ctx(webAuth) as never).surface).toBe('web');
  });
  it('Origin 不在 ALLOWED_ORIGINS → PERM_DENIED（縱深防禦，不只靠 CORS middleware）', () => {
    expect(() => requireAccountActor(ctx(webAuth, 'https://evil.example') as never)).toThrow(expect.objectContaining({ code: 'PERM_DENIED' }));
    expect(() => requireAccountActor(ctx(webAuth, WEB, { ...baseEnv, ALLOWED_ORIGINS: undefined }) as never)).toThrow(expect.objectContaining({ code: 'PERM_DENIED' }));
  });
  it.each([
    ['其他 client', { ...webAuth, clientId: 'tripline-tp-request' }],
    ['service token', { ...webAuth, isServiceToken: true }],
    ['沒有 userId', { ...webAuth, userId: undefined }],
    ['沒有 grant', { ...webAuth, grantId: undefined }],
    ['restrictTrip', { ...webAuth, restrictTrip: 't' }],
  ])('%s → PERM_DENIED', (_n, auth) => {
    expect(() => requireAccountActor(ctx(auth, WEB) as never)).toThrow(expect.objectContaining({ code: 'PERM_DENIED' }));
  });
});

describe('完整流程：web 無密碼帳號 POST → Google → verified → DELETE', () => {
  it('成功：導回固定網址 ?deleteReauth=done；DELETE 只帶 { challengeId } 即可，刪除後 challenge 清除', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect(await statusOf(challengeId)).toBe('started');
    const done = await callback(state, goodClaims(u));
    expect(done.status).toBe(302);
    expect(done.headers.get('Location')).toBe(DONE);
    expect(done.headers.get('Set-Cookie')).toBeNull();
    expect(await statusOf(challengeId)).toBe('verified');
    expect(await (await api.get(reauthUrl(challengeId), { bearer: u.token, headers: H })).json()).toEqual({ status: 'verified' });
    expect((await del(u.token, { challengeId })).status).toBe(200);
    expect(await userExists(u.id)).toBe(false);
  });

  it('{ confirm: DELETE, challengeId } 也接受', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'verified');
    expect((await del(u.token, { confirm: 'DELETE', challengeId: cid })).status).toBe(200);
    expect(await userExists(u.id)).toBe(false);
  });

  it('導回網址只由 server 決定：authorize 帶任何 redirect_uri／return_to／status 參數都不影響', async () => {
    const u = await seed();
    const { challengeId } = await (await post(u.token)).json() as { challengeId: string };
    const url = `${ORIGIN}/api/oauth/login/google?purpose=account-delete&challenge=${challengeId}&redirect_uri=https://evil.example/x&return_to=https://evil.example&status=verified&deleteReauth=done`;
    const google = await api.get(url);
    expect(google.status).toBe(302);
    const done = await callback(stateOf(google), goodClaims(u), 'code=c&redirect_uri=https://evil.example&deleteReauth=failed');
    expect(done.headers.get('Location')).toBe(DONE);
    const row = await db.prepare("SELECT payload FROM oauth_models WHERE name = 'GoogleLoginState' AND id = ?").bind(stateOf(google)).first();
    expect(JSON.stringify(row)).not.toContain('evil.example');
  });

  it.each([
    ['使用者取消 Google', async (u: U, state: string) => api.get(`${ORIGIN}/api/oauth/callback/google?error=access_denied&state=${state}`)],
    ['沒有 code', async (u: U, state: string) => callback(state, goodClaims(u), 'x=1')],
    ['別人的 Google 身分', async (_u: U, state: string) => { const o = await seed(); return callback(state, goodClaims(o)); }],
    ['auth_time 太舊', async (u: U, state: string) => callback(state, { ...goodClaims(u), auth_time: nowSec() - 3600 })],
    ['nonce 不符', async (u: U, state: string) => callback(state, { ...goodClaims(u), nonce: 'wrong' })],
  ])('驗證失敗（%s）→ 導回 ?deleteReauth=failed，challenge failed，帳號不動', async (_name, run) => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    const res = await run(u, state);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(FAILED);
    expect(await statusOf(challengeId)).toBe('failed');
    await expectReauthRequired(await del(u.token, { challengeId }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('started 時被取消，Google 之後回來 → 導回 failed，維持 cancelled，不能刪', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect((await cancel(u.token, challengeId)).status).toBe(200);
    expect((await callback(state, goodClaims(u))).headers.get('Location')).toBe(FAILED);
    expect(await statusOf(challengeId)).toBe('cancelled');
    await expectReauthRequired(await del(u.token, { challengeId }));
  });

  it('challenge 在 Google 往返中過期 → 導回 failed', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    await db.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(Date.now() - 1000, challengeId).run();
    const res = await callback(state, goodClaims(u));
    expect(res.headers.get('Location')).toBe(FAILED);
    expect(await userExists(u.id)).toBe(true);
  });

  it('state 重放 → 400 OAUTH_INVALID_STATE（沒有可識別 surface，不導回），verified 不變', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    expect((await callback(state, goodClaims(u))).headers.get('Location')).toBe(DONE);
    const replay = await callback(state, goodClaims(u));
    expect(replay.status).toBe(400);
    expect(await errorCode(replay)).toBe('OAUTH_INVALID_STATE');
    expect(await statusOf(challengeId)).toBe('verified');
  });

  it('state 帶的 clientId 被換成非 tripline-web → 不導回、不轉 verified（403 JSON）', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.reauth.clientId', 'tripline-mobile') WHERE name = 'GoogleLoginState' AND id = ?").bind(state).run();
    await expectReauthRequired(await callback(state, goodClaims(u)));
    expect(await statusOf(challengeId)).toBe('started');
  });

  it('state 的 surface 與 challenge 的 surface 不一致 → 失敗，不轉 verified', async () => {
    const u = await seed();
    const { challengeId, state } = await begin(u);
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.surface', 'mobile') WHERE name = 'AccountDeleteChallenge' AND id = ?").bind(challengeId).run();
    const res = await callback(state, goodClaims(u));
    expect(res.headers.get('Location')).toBe(FAILED);
    expect(await statusOf(challengeId)).not.toBe('verified');
  });
});

describe('GET /api/oauth/login/google?purpose=account-delete：web challenge', () => {
  const start = (cid: string) => api.get(`${ORIGIN}/api/oauth/login/google?purpose=account-delete&challenge=${cid}`);
  it('不存在的 challenge → 403 JSON；web 的 cancelled／expired／used／verified／failed → 導回 failed 且狀態不變', async () => {
    await expectReauthRequired(await start('nope'));
    const u = await seed();
    for (const status of ['cancelled', 'used', 'verified', 'failed'] as const) {
      const cid = await challengeIn(u, status);
      const res = await start(cid);
      expect(res.status, status).toBe(302);
      expect(res.headers.get('Location')).toBe(FAILED);
      expect(await statusOf(cid)).toBe(status);
    }
    const expired = await challengeIn(u, 'pending', { expiresAt: Date.now() - 1000 });
    expect((await start(expired)).headers.get('Location')).toBe(FAILED);
    expect(await statusOf(expired)).toBe('pending');
  });
  it('web challenge 的 clientId 不是 tripline-web → 不能開始，仍是 pending', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'pending', { clientId: 'tripline-mobile' });
    expect((await start(cid)).headers.get('Location') ?? '').not.toContain('accounts.google.com');
    expect(await statusOf(cid)).toBe('pending');
  });
});

describe('DELETE /api/account：web 呼叫者的 challenge 驗證', () => {
  it('未驗證的狀態、過期、已用過的 challenge 一律拒絕，帳號與 challenge 不變', async () => {
    for (const status of ['pending', 'started', 'failed', 'cancelled', 'used'] as const) {
      const u = await seed();
      const cid = await challengeIn(u, status);
      await expectReauthRequired(await del(u.token, { challengeId: cid }));
      expect(await userExists(u.id), status).toBe(true);
      expect(await statusOf(cid)).toBe(status);
    }
    const u = await seed();
    const cid = await challengeIn(u, 'verified', { expiresAt: Date.now() - 1000 });
    await expectReauthRequired(await del(u.token, { challengeId: cid }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('只帶 confirm、缺 challengeId、不存在、型別錯誤都拒絕', async () => {
    const u = await seed();
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE' }));
    const empty = await del(u.token, {});
    expect(empty.status).toBe(400);
    expect(await errorCode(empty)).toBe('ACCOUNT_DELETE_CONFIRM_REQUIRED');
    await expectReauthRequired(await del(u.token, { challengeId: 'does-not-exist' }));
    await expectReauthRequired(await del(u.token, { confirm: 'DELETE', challengeId: 42 }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('別人的 challenge、同帳號別的 grant、uid 與 grant 錯配 → 拒絕', async () => {
    const a = await seed(); const b = await seed();
    const bCh = await challengeIn(b, 'verified');
    await expectReauthRequired(await del(a.token, { challengeId: bCh }));
    const aCh = await challengeIn(a, 'verified');
    await expectReauthRequired(await del(a.tokenB, { challengeId: aCh }));
    const wrongUid = await challengeIn({ id: b.id, grantId: a.grantId }, 'verified');
    await expectReauthRequired(await del(a.token, { challengeId: wrongUid }));
    expect(await userExists(a.id) && await userExists(b.id)).toBe(true);
    expect([await statusOf(bCh), await statusOf(aCh), await statusOf(wrongUid)]).toEqual(['verified', 'verified', 'verified']);
  });

  it('surface 不符：mobile／舊紀錄（沒有 surface）的 challenge 給 web client 用、web challenge 給 mobile client 用，都拒絕', async () => {
    const web = await seed();
    const asMobile = await challengeIn(web, 'verified', { surface: 'mobile' });
    const legacy = await challengeIn(web, 'verified', { surface: null });
    await expectReauthRequired(await del(web.token, { challengeId: asMobile }));
    await expectReauthRequired(await del(web.token, { challengeId: legacy }));
    expect([await statusOf(asMobile), await statusOf(legacy)]).toEqual(['verified', 'verified']);

    const mobile = await seed({ clientId: 'tripline-mobile' });
    const mobileApi = createApi({ env: mockEnv(db, baseEnv) });
    const webSurface = await challengeIn(mobile, 'verified', { clientId: 'tripline-mobile', surface: 'web' });
    await expectReauthRequired(await del(mobile.token, { confirm: 'DELETE', challengeId: webSurface }, mobileApi));
    expect(await userExists(mobile.id) && await userExists(web.id)).toBe(true);
    expect(await statusOf(webSurface)).toBe('verified');
  });

  it('challenge 的 clientId 與呼叫者不同（surface=web 但 clientId 是別的）→ 拒絕', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'verified', { clientId: 'tripline-mobile' });
    await expectReauthRequired(await del(u.token, { challengeId: cid }));
    expect(await userExists(u.id)).toBe(true);
  });

  it('舊的 mobile challenge（沒有 surface）仍能給 mobile client 使用（相容）', async () => {
    const m = await seed({ clientId: 'tripline-mobile' });
    const cid = await challengeIn(m, 'verified', { clientId: 'tripline-mobile', surface: null });
    expect((await del(m.token, { confirm: 'DELETE', challengeId: cid })).status).toBe(200);
    expect(await userExists(m.id)).toBe(false);
  });

  it('重放：同一個 challenge 第二次被拒；兩個並行只有一個成功', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'verified');
    const results = await Promise.all([del(u.token, { challengeId: cid }), del(u.token, { challengeId: cid })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    const other = await seed();
    const used = await challengeIn(other, 'verified');
    expect((await del(other.token, { challengeId: used })).status).toBe(200);
    const again = await seed();
    const replay = await challengeIn(again, 'used');
    await expectReauthRequired(await del(again.token, { challengeId: replay }));
  });

  it('抹除失敗：整批回滾，challenge 從 used 還原成 verified，可重試', async () => {
    const u = await seed();
    const cid = await challengeIn(u, 'verified');
    const trigger = `wre_fail_${u.id.replace(/-/g, '_')}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE DELETE ON users WHEN OLD.id = '${u.id}' BEGIN SELECT RAISE(ABORT, 'simulated'); END`).run();
    try {
      expect((await del(u.token, { challengeId: cid })).status).toBeGreaterThanOrEqual(500);
      expect(await userExists(u.id)).toBe(true);
      expect(await statusOf(cid)).toBe('verified');
    } finally {
      await db.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    expect((await del(u.token, { challengeId: cid })).status).toBe(200);
  });

  it('有密碼帳號行為不變：web 也用密碼確認，不需要也不消耗 challenge', async () => {
    const u = await seed({ password: 'correct-horse-battery' });
    const cid = await challengeIn(u, 'verified');
    expect((await del(u.token, { password: 'wrong', challengeId: cid })).status).toBe(401);
    const confirmOnly = await del(u.token, { confirm: 'DELETE', challengeId: cid });
    expect(confirmOnly.status).toBe(400);
    expect(await errorCode(confirmOnly)).toBe('ACCOUNT_DELETE_CONFIRM_REQUIRED');
    expect(await statusOf(cid)).toBe('verified');
    expect((await del(u.token, { password: 'correct-horse-battery' })).status).toBe(200);
    expect(await userExists(u.id)).toBe(false);
  });

  it('其他 client（tripline-tp-request）的無密碼帳號拿 verified challenge 也刪不掉', async () => {
    const u = await seed({ clientId: 'tripline-tp-request' });
    const cid = await challengeIn(u, 'verified', { clientId: 'tripline-tp-request' });
    const res = await del(u.token, { confirm: 'DELETE', challengeId: cid });
    expect(res.status).toBe(403);
    expect(await userExists(u.id)).toBe(true);
    expect(await statusOf(cid)).toBe('verified');
  });
});

describe('GET／DELETE /api/account/delete-reauth：web 的查詢與取消', () => {
  it('綁 grant：本人可查可取消；別的 grant、別人、mobile surface 的 challenge 一律 404', async () => {
    const u = await seed(); const other = await seed();
    const { challengeId } = await (await post(u.token)).json() as { challengeId: string };
    for (const bearer of [u.tokenB, other.token]) {
      expect((await api.get(reauthUrl(challengeId), { bearer, headers: H })).status).toBe(404);
      expect((await cancel(bearer, challengeId)).status).toBe(404);
    }
    const mobileSurface = await challengeIn(u, 'pending', { surface: 'mobile' });
    expect((await api.get(reauthUrl(mobileSurface), { bearer: u.token, headers: H })).status).toBe(404);
    expect((await cancel(u.token, mobileSurface)).status).toBe(404);
    expect(await (await api.get(reauthUrl(challengeId), { bearer: u.token, headers: H })).json()).toEqual({ status: 'pending' });
    expect((await cancel(u.token, challengeId)).status).toBe(200);
    expect(await statusOf(challengeId)).toBe('cancelled');
  });
});

describe('GET /api/account：web 預覽的 reauthenticated', () => {
  it('reauthProvider=google；本 grant 有 verified 未過期的 web challenge 才為 true', async () => {
    const u = await seed();
    expect(await previewOf(u.token)).toMatchObject({ hasPassword: false, reauthProvider: 'google', reauthenticated: false });
    await challengeIn(u, 'pending');
    expect((await previewOf(u.token)).reauthenticated).toBe(false);
    const cid = await challengeIn(u, 'verified');
    expect((await previewOf(u.token)).reauthenticated).toBe(true);
    expect((await previewOf(u.tokenB)).reauthenticated, '別的 grant 不算').toBe(false);
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.status', 'used') WHERE id = ?").bind(cid).run();
    expect((await previewOf(u.token)).reauthenticated, 'used 不算').toBe(false);
    const expired = await challengeIn(u, 'verified', { expiresAt: Date.now() - 1000 });
    expect((await previewOf(u.token)).reauthenticated, '過期不算').toBe(false);
    await db.prepare('DELETE FROM oauth_models WHERE id = ?').bind(expired).run();
  });
  it('mobile surface 的 verified challenge、別人的 challenge 不讓 web 預覽變 true', async () => {
    const u = await seed(); const o = await seed();
    await challengeIn(u, 'verified', { surface: 'mobile' });
    await challengeIn(o, 'verified');
    expect((await previewOf(u.token)).reauthenticated).toBe(false);
  });
  it('有密碼帳號：reauthProvider=null、reauthenticated=false', async () => {
    const u = await seed({ password: 'pw-correct-horse' });
    await challengeIn(u, 'verified');
    expect(await previewOf(u.token)).toMatchObject({ hasPassword: true, reauthProvider: null, reauthenticated: false });
  });
});
