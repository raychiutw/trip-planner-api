/**
 * POST /api/account/password — 已登入的「變更密碼」（spec flutter#529）。
 * 與「重設密碼」不同：這裡用「目前密碼」確認本人，成功後登出其他裝置、保留目前這個 grant。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor, type TestSession } from './account-session-helper';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const PREFIX = 'chgpw';
const OLD = 'old-password-12345';
const NEW = 'brand-new-pass-678';
const MAILER = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'test-bearer' };

let db: D1Database;
let api: Api;
let seq = 0;
const userIds: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, MAILER) });
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); });

afterAll(async () => {
  for (const id of userIds) {
    await db.prepare('DELETE FROM oauth_models WHERE json_extract(payload, \'$.user_id\') = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${id}%`).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await db.prepare(`DELETE FROM client_apps WHERE client_id = 'chgpw-third-party'`).run();
  await disposeMiniflare();
});

/** 建一個使用者（可選有無 local 密碼），回登入替身。 */
async function seed(opts: { password?: string | null } = {}): Promise<TestSession & { email: string }> {
  const id = `${PREFIX}-u${++seq}`;
  const email = `${id}@example.com`;
  userIds.push(id);
  const s = await sessionFor(db, email, id);
  const password = opts.password === undefined ? OLD : opts.password;
  if (password) {
    await db.prepare(
      `INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')`,
    ).bind(id, email, await hashPassword(password)).run();
  } else {
    await db.prepare(`INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)`).bind(id, `g-${id}`).run();
  }
  return { ...s, email };
}

const stubMailer = (res: Response = new Response(JSON.stringify({ ok: true, messageId: 'm1', elapsed: 5 }), { status: 200 })) => {
  const fetchMock = vi.fn().mockResolvedValue(res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const mails = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/internal/mail/send'));
const change = (bearer: string | undefined, json: unknown) => api.request('POST', '/api/account/password', { bearer, json });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const storedHash = async (userId: string) =>
  (await db.prepare(`SELECT password_hash FROM auth_identities WHERE user_id = ? AND provider = 'local'`).bind(userId).first<{ password_hash: string }>())?.password_hash;
const grantAlive = async (grantId: string) =>
  ((await db.prepare(`SELECT count(*) AS n FROM oauth_models WHERE name IN ('AccessToken','RefreshToken') AND json_extract(payload, '$.grantId') = ?`).bind(grantId).first<{ n: number }>())!.n) > 0;

describe('POST /api/account/password', () => {
  it('401 未登入', async () => {
    const res = await change(undefined, { current_password: OLD, new_password: NEW });
    expect(res.status).toBe(401);
  });

  it('403 非第一方 client 的 token', async () => {
    const u = await seed();
    await db.prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status, first_party)
      VALUES ('chgpw-third-party', NULL, 'public', 'Third', '[]', '["openid"]', 'active', 0)`).run();
    const third = await sessionFor(db, u.email, u.userId, { clientId: 'chgpw-third-party' });
    const res = await change(third.bearer, { current_password: OLD, new_password: NEW });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('PERM_DENIED');
    expect(await verifyPassword(OLD, (await storedHash(u.userId))!)).toBe(true);
  });

  it('成功：密碼換成新的、舊密碼失效、回 200 { ok: true }', async () => {
    const u = await seed();
    stubMailer();
    const res = await change(u.bearer, { current_password: OLD, new_password: NEW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const h = (await storedHash(u.userId))!;
    expect(await verifyPassword(NEW, h)).toBe(true);
    expect(await verifyPassword(OLD, h)).toBe(false);
  });

  it('成功：其他 grant 全部失效，目前這個 grant 仍可用', async () => {
    const u = await seed();
    const other = await sessionFor(db, u.email, u.userId);
    stubMailer();
    expect((await change(u.bearer, { current_password: OLD, new_password: NEW })).status).toBe(200);
    expect(await grantAlive(other.grantId)).toBe(false);
    expect(await grantAlive(u.grantId)).toBe(true);
    expect((await api.get('/api/account/sessions', { bearer: u.bearer })).status).toBe(200);
  });

  it('成功：別的使用者的 grant 不受影響', async () => {
    const u = await seed();
    const stranger = await seed();
    stubMailer();
    expect((await change(u.bearer, { current_password: OLD, new_password: NEW })).status).toBe(200);
    expect(await grantAlive(stranger.grantId)).toBe(true);
  });

  it('成功：寄出「密碼已更改」通知信給本人', async () => {
    const u = await seed();
    const m = stubMailer();
    await change(u.bearer, { current_password: OLD, new_password: NEW });
    const sent = mails(m);
    expect(sent).toHaveLength(1);
    const payload = String(sent[0]![1]?.body);
    expect(payload).toContain(u.email);
    expect(payload).toContain('密碼已更改'); // 信件內容是「密碼已更改」通知，不只是收件人對
  });

  it('成功：寄信失敗不影響結果（仍 200、密碼已換）', async () => {
    const u = await seed();
    stubMailer(new Response('boom', { status: 500 }));
    const res = await change(u.bearer, { current_password: OLD, new_password: NEW });
    expect(res.status).toBe(200);
    expect(await verifyPassword(NEW, (await storedHash(u.userId))!)).toBe(true);
  });

  it('成功：留下稽核紀錄 password_change / success', async () => {
    const u = await seed();
    stubMailer();
    await change(u.bearer, { current_password: OLD, new_password: NEW });
    const row = await db.prepare(`SELECT outcome FROM auth_audit_log WHERE user_id = ? AND event_type = 'password_change'`).bind(u.userId).first<{ outcome: string }>();
    expect(row?.outcome).toBe('success');
  });

  it('403 CHANGE_PASSWORD_CURRENT_INVALID：目前密碼錯，不動任何資料、不踢其他裝置、不寄信', async () => {
    const u = await seed();
    const other = await sessionFor(db, u.email, u.userId);
    const m = stubMailer();
    const res = await change(u.bearer, { current_password: 'not-my-password', new_password: NEW });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CHANGE_PASSWORD_CURRENT_INVALID');
    expect(await verifyPassword(OLD, (await storedHash(u.userId))!)).toBe(true);
    expect(await grantAlive(other.grantId)).toBe(true);
    expect(mails(m)).toHaveLength(0);
    const row = await db.prepare(`SELECT outcome, failure_reason FROM auth_audit_log WHERE user_id = ? AND event_type = 'password_change'`).bind(u.userId).first<{ outcome: string; failure_reason: string }>();
    expect(row).toEqual({ outcome: 'failure', failure_reason: 'current_invalid' });
  });

  it('403 CHANGE_PASSWORD_CURRENT_INVALID：沒帶目前密碼', async () => {
    const u = await seed();
    const res = await change(u.bearer, { new_password: NEW });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CHANGE_PASSWORD_CURRENT_INVALID');
  });

  it('400 CHANGE_PASSWORD_TOO_SHORT：新密碼少於 8 字元，密碼不變', async () => {
    const u = await seed();
    const res = await change(u.bearer, { current_password: OLD, new_password: 'short' });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('CHANGE_PASSWORD_TOO_SHORT');
    expect(await verifyPassword(OLD, (await storedHash(u.userId))!)).toBe(true);
  });

  it('400：沒帶 new_password（body 驗證擋下），密碼不變、其他 grant 不受影響', async () => {
    const u = await seed();
    const other = await sessionFor(db, u.email, u.userId);
    const res = await change(u.bearer, { current_password: OLD });
    expect(res.status).toBe(400);
    expect(await verifyPassword(OLD, (await storedHash(u.userId))!)).toBe(true);
    expect(await grantAlive(other.grantId)).toBe(true);
  });

  it('撤銷其他 grant 失敗（best-effort）：密碼已換，仍回 200', async () => {
    const u = await seed();
    await sessionFor(db, u.email, u.userId);
    stubMailer();
    const spy = vi.spyOn(D1Adapter.prototype, 'revokeByGrantId').mockRejectedValue(new Error('d1 down'));
    try {
      const res = await change(u.bearer, { current_password: OLD, new_password: NEW });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      expect(await verifyPassword(NEW, (await storedHash(u.userId))!)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('400 CHANGE_PASSWORD_SAME：新舊密碼相同', async () => {
    const u = await seed();
    const res = await change(u.bearer, { current_password: OLD, new_password: OLD });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('CHANGE_PASSWORD_SAME');
  });

  it('409 CHANGE_PASSWORD_NO_PASSWORD：只用 Google 登入、沒有 local 密碼', async () => {
    const u = await seed({ password: null });
    const res = await change(u.bearer, { current_password: OLD, new_password: NEW });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('CHANGE_PASSWORD_NO_PASSWORD');
  });

  it('429 CHANGE_PASSWORD_RATE_LIMITED：連續輸錯目前密碼會被鎖，鎖住後連正確密碼也不放行', async () => {
    const u = await seed();
    stubMailer();
    for (let i = 0; i < 5; i++) {
      expect((await change(u.bearer, { current_password: `wrong-${i}-xxxx`, new_password: NEW })).status).toBe(403);
    }
    expect((await change(u.bearer, { current_password: 'wrong-6-xxxx', new_password: NEW })).status).toBe(429); // 第 6 次錯才上鎖
    const locked = await change(u.bearer, { current_password: OLD, new_password: NEW });
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe('CHANGE_PASSWORD_RATE_LIMITED');
    expect(locked.headers.get('Retry-After')).toBeTruthy();
    expect(await verifyPassword(OLD, (await storedHash(u.userId))!)).toBe(true);
  });

  it('成功後清掉輸錯計次：成功前輸錯 4 次，成功後再輸錯 4 次仍是 403，不會被累計鎖住', async () => {
    const u = await seed();
    stubMailer();
    for (let i = 0; i < 4; i++) {
      expect((await change(u.bearer, { current_password: `wrong-${i}-xxxx`, new_password: NEW })).status).toBe(403);
    }
    expect((await change(u.bearer, { current_password: OLD, new_password: NEW })).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await change(u.bearer, { current_password: `again-${i}-xxxx`, new_password: 'another-pass-999' })).status).toBe(403);
    }
  });
});
