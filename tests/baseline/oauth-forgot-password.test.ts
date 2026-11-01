/**
 * POST /api/oauth/forgot-password — V2-P3
 * 走 HTTP 邊界（tests/api/http.ts）；原本檢查 mock DB 呼叫形狀的斷言，改讀真實 D1 的資料變化
 * （oauth_models 的 PasswordReset token、rate_limit_buckets、audit_log、auth_audit_log）。
 * 寄信走 mac mini mailer 的 fetch，是外部邊界，用 vi.stubGlobal 攔截並斷言寄出內容與收件者。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { sha256Base64 } from '../../src/lib/utils';

const PREFIX = 'oauth-forgot-test';
const emailOf = (name: string) => `${PREFIX}-${name}@x.com`;
const MAILER = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'test-bearer' };

let db: D1Database;
let seq = 0;
const userIds: string[] = [];
const bucketKeys: string[] = [];
const ips: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const id of userIds) {
    await db.prepare("DELETE FROM oauth_models WHERE name = 'PasswordReset' AND json_extract(payload, '$.userId') = ?").bind(id).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await db.prepare("DELETE FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?").bind(`%${PREFIX}%`).run();
  for (const k of bucketKeys) await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(k).run();
  for (const ip of ips) await db.prepare('DELETE FROM auth_audit_log WHERE ip_hash = ?').bind(await sha256Base64(ip)).run();
  await disposeMiniflare();
});

async function seedUser(name: string, opts: { provider?: string; displayName?: string | null } = {}) {
  const id = `${PREFIX}-${name}-${++seq}`;
  const email = emailOf(`${name}-${seq}`);
  await db.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
    .bind(id, email, opts.displayName === undefined ? name : opts.displayName).run();
  await db
    .prepare('INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, ?, ?, ?, ?)')
    .bind(id, opts.provider ?? 'local', opts.provider && opts.provider !== 'local' ? `sub-${id}` : email, opts.provider && opts.provider !== 'local' ? null : 'x', opts.provider && opts.provider !== 'local' ? null : 'pbkdf2')
    .run();
  userIds.push(id);
  return { id, email };
}

function freshIp(): string {
  const ip = `10.55.0.${++seq}`;
  ips.push(ip);
  bucketKeys.push(`forgot-password:${ip}`);
  return ip;
}

async function forgot(body: unknown, env: Record<string, unknown> = {}, ip = freshIp()) {
  if (body && typeof body === 'object' && 'email' in body) {
    bucketKeys.push(`forgot-password:${String((body as { email: string }).email).trim().toLowerCase()}`);
  }
  return createApi({ env: mockEnv(db, env as never) }).request('POST', 'https://x.com/api/oauth/forgot-password', {
    json: body,
    headers: { 'CF-Connecting-IP': ip },
  });
}

const resetTokensFor = async (userId: string) =>
  (await db
    .prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'PasswordReset' AND json_extract(payload, '$.userId') = ?")
    .bind(userId)
    .all<{ id: string; payload: string; expires_at: number }>()).results!;

const mailerStub = (response: Response) => {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const okMail = () => new Response(JSON.stringify({ ok: true, messageId: 'msg-test', elapsed: 200 }), { status: 200 });
const mailerCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/internal/mail/send'));

describe('POST /api/oauth/forgot-password', () => {
  it('200 generic response when email empty (no enum leak)', async () => {
    const res = await forgot({});
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('若 email 已註冊');
  });

  it('200 generic response when email not found (no enum leak)', async () => {
    const fetchMock = mailerStub(okMail());
    const res = await forgot({ email: emailOf('nobody') }, MAILER);
    expect(res.status).toBe(200);
    const json = await res.json() as { message: string };
    expect(json.message).toContain('若 email 已註冊');
    // 沒有該使用者 → 不產 token、不寄信
    expect(mailerCalls(fetchMock)).toHaveLength(0);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'PasswordReset' AND json_extract(payload, '$.email') = ?")
      .bind(emailOf('nobody')).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('200 + 寫入 PasswordReset token（含 userId）+ 寄信 when email + local provider exist', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('exists');
    const res = await forgot({ email: u.email }, MAILER);
    expect(res.status).toBe(200);

    const tokens = await resetTokensFor(u.id);
    expect(tokens).toHaveLength(1);
    expect(JSON.parse(tokens[0]!.payload)).toMatchObject({ userId: u.id, email: u.email, used: false });
    expect(mailerCalls(fetchMock)).toHaveLength(1);
  });

  it('email lowercase + trim before lookup', async () => {
    mailerStub(okMail());
    const u = await seedUser('mixed');
    const res = await forgot({ email: `  ${u.email.toUpperCase()}  ` }, MAILER);
    expect(res.status).toBe(200);
    expect(await resetTokensFor(u.id)).toHaveLength(1);
  });

  it('Token TTL = 1h (3600s) per V2-P3 spec', async () => {
    mailerStub(okMail());
    const u = await seedUser('ttl');
    const before = Date.now();
    await forgot({ email: u.email }, MAILER);
    const after = Date.now();
    const [token] = await resetTokensFor(u.id);
    expect(token!.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(token!.expires_at).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it('Local provider lookup filter: WHERE provider = "local" (not Google-only user)', async () => {
    const fetchMock = mailerStub(okMail());
    const googleOnly = await seedUser('google-only', { provider: 'google' });
    const res = await forgot({ email: googleOnly.email }, MAILER);
    expect(res.status).toBe(200);
    expect(await resetTokensFor(googleOnly.id)).toHaveLength(0);
    expect(mailerCalls(fetchMock)).toHaveLength(0);
  });

  it('429 FORGOT_PASSWORD_RATE_LIMITED when IP bucket locked', async () => {
    const fetchMock = mailerStub(okMail());
    const ip = freshIp();
    await db
      .prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
      .bind(`forgot-password:${ip}`, 4, Date.now(), Date.now() + 60_000)
      .run();
    const u = await seedUser('iplocked');
    const res = await forgot({ email: u.email }, MAILER, ip);
    expect(res.status).toBe(429);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('FORGOT_PASSWORD_RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // 被擋下就不該產 token 或寄信
    expect(await resetTokensFor(u.id)).toHaveLength(0);
    expect(mailerCalls(fetchMock)).toHaveLength(0);
  });

  it('429 when the same email is requested more than 3 times in an hour (per-email bucket)', async () => {
    mailerStub(okMail());
    const u = await seedUser('emaillocked');
    for (let i = 0; i < 4; i++) expect((await forgot({ email: u.email }, MAILER)).status).toBe(200);
    const res = await forgot({ email: u.email }, MAILER);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORGOT_PASSWORD_RATE_LIMITED');
  });

  it('Bumps both ipKey + emailKey buckets on every valid request (defence in depth)', async () => {
    const ip = freshIp();
    const email = emailOf('bump-nobody');
    const res = await forgot({ email }, {}, ip);
    expect(res.status).toBe(200); // generic 200 regardless

    const ipBucket = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(`forgot-password:${ip}`).first<{ count: number }>();
    const emailBucket = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(`forgot-password:${email}`).first<{ count: number }>();
    expect(ipBucket!.count).toBe(1);
    expect(emailBucket!.count).toBe(1);
  });

  it('sends reset email via mac mini tunnel (post-2026-05-02 cutover)', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('mailer', { displayName: 'Ray' });
    const ip = freshIp();
    const res = await forgot({ email: u.email }, MAILER, ip);
    expect(res.status).toBe(200);

    const calls = mailerCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('https://mac-mini.tail.ts.net:8443/internal/mail/send');
    const init = calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-bearer');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.to).toBe(u.email);
    expect(body.subject).toContain('重設');
    // 信裡的連結帶的就是剛寫入 D1 的 token
    const [stored] = await resetTokensFor(u.id);
    expect(body.html).toContain(`https://x.com/auth/password/reset?token=${encodeURIComponent(stored!.id)}`);
    expect(body.template).toBe('forgot-password');

    // 稽核：email 寄送成功 + auth_audit_log 成功事件（只存遮罩 email）
    const emailAudit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`).first<{ diff_json: string }>();
    expect(JSON.parse(emailAudit!.diff_json)).toMatchObject({ template: 'forgot-password', status: 'sent' });
    const authAudit = await db
      .prepare("SELECT outcome, metadata FROM auth_audit_log WHERE event_type = 'password_reset_request' AND user_id = ?")
      .bind(u.id).first<{ outcome: string; metadata: string }>();
    expect(authAudit!.outcome).toBe('success');
    expect(authAudit!.metadata).not.toContain(u.email);
  });

  it('200 generic + audit when TRIPLINE_API_URL unset (v2.33.59 round 13: background send anti-enum)', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('nourl');
    const res = await forgot({ email: u.email });
    // 改 background send via context.waitUntil → 200 generic (anti-enum)；失敗只記 audit，不洩漏給 caller
    expect(res.status).toBe(200);

    const emailAudit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`).first<{ diff_json: string }>();
    expect(JSON.parse(emailAudit!.diff_json)).toMatchObject({ template: 'forgot-password', status: 'failed' });
    const authAudit = await db
      .prepare("SELECT outcome, metadata FROM auth_audit_log WHERE event_type = 'password_reset_request' AND user_id = ?")
      .bind(u.id).first<{ outcome: string; metadata: string }>();
    expect(authAudit!.outcome).toBe('failure');
    expect(authAudit!.metadata).not.toContain(u.email);
    // sendEmail 在缺 env 時 fetch 之前就丟錯；Telegram 因缺設定也略過
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
