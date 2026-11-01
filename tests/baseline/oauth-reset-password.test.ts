/**
 * POST /api/oauth/reset-password — V2-P3
 * 走 HTTP 邊界（tests/api/http.ts）；原本檢查 mock DB 呼叫形狀的斷言，改讀真實 D1 的資料變化
 * （auth_identities 密碼雜湊、oauth_models 的 PasswordReset token、session_devices、audit_log、auth_audit_log）。
 * 確認信走 mac mini mailer 的 fetch，是外部邊界，用 vi.stubGlobal 攔截並斷言寄出內容與收件者。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { sha256Base64 } from '../../src/lib/utils';

const PREFIX = 'oauth-reset-test';
const OLD_PASSWORD = 'old-password-12345';
const MAILER = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'test-bearer' };

let db: D1Database;
let seq = 0;
let oldHash: string;
const userIds: string[] = [];
const tokenIds: string[] = [];
const ips: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  oldHash = await hashPassword(OLD_PASSWORD);
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const id of tokenIds) await db.prepare("DELETE FROM oauth_models WHERE name = 'PasswordReset' AND id = ?").bind(id).run();
  for (const id of userIds) {
    await db.prepare('DELETE FROM session_devices WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await db.prepare("DELETE FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?").bind(`%${PREFIX}%`).run();
  for (const ip of ips) {
    await db.prepare('DELETE FROM auth_audit_log WHERE ip_hash = ?').bind(await sha256Base64(ip)).run();
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(`reset-password:${ip}`).run();
  }
  await disposeMiniflare();
});

function freshIp(): string {
  const ip = `10.44.0.${++seq}`;
  ips.push(ip);
  return ip;
}

async function seedUser(name: string, opts: { displayName?: string | null } = {}) {
  const id = `${PREFIX}-${name}-${++seq}`;
  const email = `${PREFIX}-${name}-${seq}@x.com`;
  await db.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
    .bind(id, email, opts.displayName === undefined ? name : opts.displayName).run();
  await db
    .prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')")
    .bind(id, email, oldHash).run();
  userIds.push(id);
  return { id, email };
}

async function seedToken(u: { id: string; email: string }, opts: { expiresAt?: number; consumed?: number; used?: boolean } = {}) {
  const id = `${PREFIX}-token-${++seq}`;
  const payload = {
    userId: u.id, email: u.email, createdAt: Date.now(),
    ...(opts.consumed ? { consumed: opts.consumed } : {}),
    ...(opts.used !== undefined ? { used: opts.used } : {}),
  };
  await db.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('PasswordReset', ?, ?, ?)")
    .bind(id, JSON.stringify(payload), opts.expiresAt ?? Date.now() + 30 * 60_000).run();
  tokenIds.push(id);
  return id;
}

async function reset(body: unknown, env: Record<string, unknown> = {}, ip = freshIp()) {
  return createApi({ env: mockEnv(db, env as never) }).request('POST', 'https://x.com/api/oauth/reset-password', {
    json: body,
    headers: { 'CF-Connecting-IP': ip },
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

const storedHash = async (userId: string, provider = 'local') =>
  (await db.prepare('SELECT password_hash FROM auth_identities WHERE user_id = ? AND provider = ?').bind(userId, provider)
    .first<{ password_hash: string | null }>())?.password_hash ?? null;

const tokenPayload = async (id: string) =>
  JSON.parse((await db.prepare("SELECT payload FROM oauth_models WHERE name = 'PasswordReset' AND id = ?").bind(id).first<{ payload: string }>())!.payload) as Record<string, unknown>;

const mailerStub = (response: Response) => {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const okMail = () => new Response(JSON.stringify({ ok: true, messageId: 'msg-1', elapsed: 200 }), { status: 200 });
const mailerCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/internal/mail/send'));

describe('POST /api/oauth/reset-password', () => {
  it('400 RESET_TOKEN_MISSING when token empty', async () => {
    const res = await reset({ password: 'newpass123' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('RESET_TOKEN_MISSING');
  });

  it('400 RESET_PASSWORD_TOO_SHORT when password < 8 chars（token 不被消耗、密碼不變）', async () => {
    const u = await seedUser('short');
    const token = await seedToken(u);
    const res = await reset({ token, password: 'short' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('RESET_PASSWORD_TOO_SHORT');
    expect(await storedHash(u.id)).toBe(oldHash);
    expect((await tokenPayload(token)).consumed).toBeUndefined();
  });

  it('400 RESET_TOKEN_INVALID when token not in D1 (expired or never existed)', async () => {
    const ip = freshIp();
    const res = await reset({ token: 'expired', password: 'newpass1234' }, {}, ip);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('RESET_TOKEN_INVALID');
    const audit = await db
      .prepare("SELECT outcome, failure_reason FROM auth_audit_log WHERE event_type = 'password_reset_complete' AND ip_hash = ?")
      .bind(await sha256Base64(ip)).first<{ outcome: string; failure_reason: string }>();
    expect(audit).toMatchObject({ outcome: 'failure', failure_reason: 'invalid_token' });
  });

  it('過期的 token → 400 RESET_TOKEN_INVALID，密碼不變', async () => {
    const u = await seedUser('expired');
    const token = await seedToken(u, { expiresAt: Date.now() - 60_000 });
    const res = await reset({ token, password: 'new-secure-password-123' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('RESET_TOKEN_INVALID');
    expect(await storedHash(u.id)).toBe(oldHash);
  });

  it('happy path: 200 + 密碼雜湊更新 + token 標為已使用 + 撤銷所有 session', async () => {
    mailerStub(okMail());
    const u = await seedUser('happy');
    const token = await seedToken(u);
    await db.prepare('INSERT INTO session_devices (sid, user_id) VALUES (?, ?), (?, ?)')
      .bind(`${PREFIX}-sid-a-${seq}`, u.id, `${PREFIX}-sid-b-${seq}`, u.id).run();
    // 新 api 的憑證是 bearer token：該使用者的 access / refresh token 也要全部撤銷，別人的不受影響
    const other = await seedUser('other-tokens');
    const seedTok = async (name: string, uid: string) => {
      const id = `${PREFIX}-${name}-${++seq}`;
      await db.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)')
        .bind(name, id, JSON.stringify({ user_id: uid, grantId: `g-${id}` }), Date.now() + 600_000).run();
      return id;
    };
    const mineA = await seedTok('AccessToken', u.id);
    const mineR = await seedTok('RefreshToken', u.id);
    const theirs = await seedTok('AccessToken', other.id);
    const present = async (name: string, id: string) =>
      !!(await db.prepare('SELECT 1 AS x FROM oauth_models WHERE name = ? AND id = ?').bind(name, id).first());

    const res = await reset({ token, password: 'new-secure-password-123' });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('密碼已更新');

    // 密碼雜湊已換成新密碼（舊密碼不再通過）
    const hash = await storedHash(u.id);
    expect(hash).not.toBe(oldHash);
    expect(await verifyPassword('new-secure-password-123', hash!)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, hash!)).toBe(false);

    // token 保留到 expires_at 但標為 consumed，連點會看到「已使用」
    expect((await tokenPayload(token)).consumed).toBeTruthy();

    // 所有既有 session 都被撤銷
    const sessions = await db.prepare('SELECT revoked_at FROM session_devices WHERE user_id = ?').bind(u.id)
      .all<{ revoked_at: string | null }>();
    expect(sessions.results).toHaveLength(2);
    for (const s of sessions.results!) expect(s.revoked_at).toBeTruthy();

    expect(await present('AccessToken', mineA)).toBe(false);
    expect(await present('RefreshToken', mineR)).toBe(false);
    expect(await present('AccessToken', theirs)).toBe(true);
    await db.prepare("DELETE FROM oauth_models WHERE id = ?").bind(theirs).run();
    // 不自動登入：回應沒有 cookie、沒有 token 欄位
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(Object.keys(json).sort()).toEqual(['message', 'ok']);

    // 稽核：重設完成事件
    const audit = await db
      .prepare("SELECT outcome FROM auth_audit_log WHERE event_type = 'password_reset_complete' AND user_id = ?")
      .bind(u.id).first<{ outcome: string }>();
    expect(audit!.outcome).toBe('success');
  }, 30_000);

  it('400 when token already used (one-time use guard)', async () => {
    const u = await seedUser('used');
    const token = await seedToken(u, { used: true });
    const res = await reset({ token, password: 'newpass1234' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('RESET_TOKEN_INVALID');
    expect(await storedHash(u.id)).toBe(oldHash);
  });

  it('同一個 token 用兩次：第一次成功，第二次被擋且密碼仍是第一次設的（不可重複使用）', async () => {
    mailerStub(okMail());
    const u = await seedUser('twice');
    const token = await seedToken(u);
    const first = await reset({ token, password: 'first-new-password-1' });
    expect(first.status).toBe(200);
    const second = await reset({ token, password: 'second-new-password-2' });
    expect(second.status).toBe(400);
    expect(await errorCode(second)).toBe('RESET_TOKEN_INVALID');
    expect(await verifyPassword('first-new-password-1', (await storedHash(u.id))!)).toBe(true);
  }, 30_000);

  it('UPDATE filters provider=local (不影響 Google identity)', async () => {
    mailerStub(okMail());
    const u = await seedUser('google');
    await db
      .prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash) VALUES (?, 'google', ?, ?)")
      .bind(u.id, `sub-${u.id}`, 'google-sentinel').run();
    const token = await seedToken(u);
    const res = await reset({ token, password: 'newpass1234' });
    expect(res.status).toBe(200);
    expect(await storedHash(u.id, 'google')).toBe('google-sentinel');
    expect(await storedHash(u.id, 'local')).not.toBe(oldHash);
  }, 30_000);

  it('sends confirmation email via mac mini tunnel (post-2026-05-02 cutover)', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('mailer', { displayName: 'Ray' });
    const token = await seedToken(u);
    const res = await reset({ token, password: 'newpass1234' }, MAILER);
    expect(res.status).toBe(200);

    const calls = mailerCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const init = calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-bearer');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.to).toBe(u.email);
    expect(body.subject).toContain('密碼');
    expect(body.template).toBe('reset-password-confirm');

    const audit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`).first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ template: 'reset-password-confirm', status: 'sent' });
  }, 30_000);

  it('still returns 200 when confirmation email fails (best-effort, password updated)', async () => {
    // confirmation email is "事後通知" — failure should not block 200 response.
    // sendEmail throws (no TRIPLINE_API_URL); caught best-effort + audit + alert.
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('mailfail');
    const token = await seedToken(u);
    const res = await reset({ token, password: 'newpass1234' });
    expect(res.status).toBe(200);
    // 密碼確實已更新
    expect(await verifyPassword('newpass1234', (await storedHash(u.id))!)).toBe(true);

    const audit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`).first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ template: 'reset-password-confirm', status: 'failed' });
    // sendEmail 缺 env 時 fetch 之前就丟錯；Telegram 因缺設定也略過
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it('每次格式合法的嘗試都累加 IP bucket；連續失敗超過上限後被鎖定（防暴力猜 token）', async () => {
    const ip = freshIp();
    for (let i = 0; i < 6; i++) {
      expect((await reset({ token: `guess-${i}`, password: 'newpass1234' }, {}, ip)).status).toBe(400);
    }
    const bucket = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(`reset-password:${ip}`).first<{ count: number }>();
    expect(bucket!.count).toBe(6);
    const locked = await reset({ token: 'guess-next', password: 'newpass1234' }, {}, ip);
    expect(locked.status).toBe(429);
    expect(await errorCode(locked)).toBe('RESET_RATE_LIMITED');
  });

  it('429 RESET_RATE_LIMITED when IP bucket locked（不處理 token）', async () => {
    const u = await seedUser('ratelimited');
    const token = await seedToken(u);
    const ip = freshIp();
    await db
      .prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
      .bind(`reset-password:${ip}`, 6, Date.now(), Date.now() + 60_000).run();
    const res = await reset({ token, password: 'newpass1234' }, {}, ip);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('RESET_RATE_LIMITED');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await storedHash(u.id)).toBe(oldHash);
    expect((await tokenPayload(token)).consumed).toBeUndefined();
  });
});
