/**
 * POST /api/oauth/signup — V2-P2
 * 走 HTTP 邊界（tests/api/http.ts）；原本檢查 mock DB 呼叫形狀的斷言，改讀真實 D1 的資料變化
 * （users、auth_identities、auth_audit_log、rate_limit_buckets、trip_permissions、trip_invitations）。
 *
 * 2026-07-20 起註冊必須帶 `privacyConsent: true`。`signup()` 預設補上，讓本檔案例只驗自己關心的事；
 * 同意 gate 本身的測試在 `tests/api/signup-consent.test.ts`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { sha256Base64 } from '../../src/lib/utils';
import { hashInvitationToken } from '../../src/lib/invitation-token';

const SECRET = 'session-secret-test-32-chars-long';
const PREFIX = 'oauth-signup-test';
const emailOf = (name: string) => `${PREFIX}-${name}@example.com`;

let db: D1Database;
let seq = 0;
const ips: string[] = [];
const emails = new Set<string>();
const tripIds: string[] = [];
const tokenHashes: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

afterAll(async () => {
  for (const email of emails) {
    const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
    if (user) {
      await db.prepare('DELETE FROM trip_permissions WHERE user_id = ?').bind(user.id).run();
      await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(user.id).run();
      await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(user.id).run();
    }
  }
  for (const ip of ips) await db.prepare('DELETE FROM auth_audit_log WHERE ip_hash = ?').bind(await sha256Base64(ip)).run();
  for (const h of tokenHashes) await db.prepare('DELETE FROM trip_invitations WHERE token_hash = ?').bind(h).run();
  for (const id of tripIds) await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  for (const email of emails) await db.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
  for (const ip of ips) await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(`signup:${ip}`).run();
  await disposeMiniflare();
});

const api = () => createApi({ env: mockEnv(db, { SESSION_SECRET: SECRET }) });

function freshIp(): string {
  const ip = `10.77.0.${++seq}`;
  ips.push(ip);
  return ip;
}

async function signup(body: Record<string, unknown> | null, ip = freshIp()): Promise<Response> {
  const email = body && typeof body.email === 'string' ? body.email : null;
  if (email) emails.add(email.trim().toLowerCase());
  const payload = body === null ? undefined : { privacyConsent: true, ...body };
  return api().request('POST', 'https://x.com/api/oauth/signup', {
    json: payload,
    headers: { 'CF-Connecting-IP': ip },
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function userByEmail(email: string) {
  return db.prepare('SELECT id, email, display_name FROM users WHERE email = ?').bind(email)
    .first<{ id: string; email: string; display_name: string | null }>();
}

async function seedInvitation(opts: { invitedEmail: string; expiresAt: string }) {
  const n = ++seq;
  const tripId = `${PREFIX}-trip-${n}`;
  const inviterEmail = emailOf(`inviter-${n}`);
  emails.add(inviterEmail);
  const inviterId = `${PREFIX}-inviter-${n}`;
  await db.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(inviterId, inviterEmail, 'inviter').run();
  await db.prepare('INSERT INTO trips (id, name, title, owner_user_id, published) VALUES (?, ?, ?, ?, 1)').bind(tripId, '沖繩 5 日', '沖繩 5 日', inviterId).run();
  tripIds.push(tripId);
  const raw = `raw-invite-token-${n}`;
  const hash = await hashInvitationToken(raw, SECRET);
  tokenHashes.push(hash);
  await db
    .prepare('INSERT INTO trip_invitations (token_hash, trip_id, invited_email, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, tripId, opts.invitedEmail, inviterId, opts.expiresAt)
    .run();
  return { tripId, raw, hash };
}

const future = () => new Date(Date.now() + 7 * 86400_000).toISOString();
const past = () => new Date(Date.now() - 5 * 86400_000).toISOString();

describe('POST /api/oauth/signup', () => {
  it('400 SIGNUP_INVALID_EMAIL when email missing or invalid', async () => {
    const r1 = await signup({ password: 'longenough' });
    expect(r1.status).toBe(400);
    expect(await errorCode(r1)).toBe('SIGNUP_INVALID_EMAIL');

    const r2 = await signup({ email: 'not-an-email', password: 'longenough' });
    expect(r2.status).toBe(400);
    expect(await errorCode(r2)).toBe('SIGNUP_INVALID_EMAIL');
  });

  it('400 SIGNUP_PASSWORD_TOO_SHORT when password < 8 chars', async () => {
    const email = emailOf('short');
    const res = await signup({ email, password: 'short' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('SIGNUP_PASSWORD_TOO_SHORT');
    expect(await userByEmail(email)).toBeNull();
  });

  it('409 SIGNUP_EMAIL_TAKEN when email already in users', async () => {
    const email = emailOf('taken');
    const first = await signup({ email, password: 'longenough' });
    expect(first.status).toBe(201);
    const res = await signup({ email, password: 'longenough' });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('SIGNUP_EMAIL_TAKEN');
    const count = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind(email).first<{ n: number }>();
    expect(count!.n).toBe(1);
  }, 30_000);

  it('happy path: 201 + users + auth_identities（雜湊密碼）+ 不發任何登入憑證', async () => {
    const email = emailOf('new');
    const res = await signup({ email, password: 'a-secure-password-1234', displayName: 'New User' });

    expect(res.status).toBe(201);
    const json = await res.json() as { ok: boolean; userId: string; email: string; requiresVerification: boolean };
    // 行為變更：舊入口回 Set-Cookie: tripline_session；新 api 不發 cookie、回應也不含任何 token 欄位
    expect(Object.keys(json).sort()).toEqual(['email', 'invitationError', 'joinedTrip', 'ok', 'requiresVerification', 'userId']);
    expect(json.ok).toBe(true);
    expect(json.email).toBe(email);
    expect(json.requiresVerification).toBe(true);
    expect(typeof json.userId).toBe('string');

    expect(res.headers.get('Set-Cookie')).toBeNull();
    // 註冊也不會偷偷建立任何 access / refresh token
    const tokens = await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name IN ('AccessToken','RefreshToken','Session') AND json_extract(payload, '$.user_id') = ?").bind(json.userId).first<{ n: number }>();
    expect(tokens!.n).toBe(0);
    const devices = await db.prepare('SELECT COUNT(*) AS n FROM session_devices WHERE user_id = ?').bind(json.userId).first<{ n: number }>();
    expect(devices!.n).toBe(0);

    const user = await userByEmail(email);
    expect(user!.id).toBe(json.userId);
    expect(user!.display_name).toBe('New User');
    const identity = await db
      .prepare('SELECT provider, provider_user_id, password_hash, password_algo FROM auth_identities WHERE user_id = ?')
      .bind(json.userId)
      .first<{ provider: string; provider_user_id: string; password_hash: string; password_algo: string }>();
    expect(identity!.provider).toBe('local');
    expect(identity!.provider_user_id).toBe(email);
    expect(identity!.password_algo).toBe('pbkdf2');
    expect(identity!.password_hash).toBeTruthy();
    expect(identity!.password_hash).not.toContain('a-secure-password-1234');
  }, 30_000); // PBKDF2 600k iter takes time

  it('email lowercased + trimmed before INSERT', async () => {
    const res = await signup({ email: `  ${PREFIX}-Mixed.Case@EXAMPLE.com  `, password: 'password123' });
    expect(res.status).toBe(201);
    expect(await userByEmail(`${PREFIX}-mixed.case@example.com`)).not.toBeNull();
  }, 30_000);

  it('UNIQUE constraint race condition → 409 SIGNUP_EMAIL_TAKEN', async () => {
    // 兩個同 email 的請求同時送出：只會有一個建立帳號，另一個必須是 409（不是 500）
    const email = emailOf('race');
    const [a, b] = await Promise.all([
      signup({ email, password: 'longenough' }),
      signup({ email, password: 'longenough' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await errorCode(loser)).toBe('SIGNUP_EMAIL_TAKEN');
    const count = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind(email).first<{ n: number }>();
    expect(count!.n).toBe(1);
  }, 60_000);

  it('429 SIGNUP_RATE_LIMITED when IP bucket locked', async () => {
    const ip = freshIp();
    await db
      .prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
      .bind(`signup:${ip}`, 4, Date.now(), Date.now() + 60_000)
      .run();
    const email = emailOf('limited');
    const res = await signup({ email, password: 'longenough' }, ip);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('SIGNUP_RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await userByEmail(email)).toBeNull();
  });

  it('Bumps signup ipKey bucket on every valid attempt (anti spam)', async () => {
    const email = emailOf('bump');
    const ip = freshIp();
    expect((await signup({ email, password: 'longenough' }, ip)).status).toBe(201);
    // 同 IP 再註冊同 email → 409，但 rate limit bucket 仍要被累加（單一 ipKey bucket，沒有 per-email）
    const res = await signup({ email, password: 'longenough' }, ip);
    expect(res.status).toBe(409);
    const bucket = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(`signup:${ip}`).first<{ count: number }>();
    expect(bucket!.count).toBe(2);
  }, 30_000);

  it('稽核：成功與 email_taken 各寫一筆 auth_audit_log，email 只存遮罩版', async () => {
    const email = emailOf('audit');
    const ip = freshIp();
    const ok = await signup({ email, password: 'longenough' }, ip);
    const { userId } = await ok.json() as { userId: string };
    await signup({ email, password: 'longenough' }, ip);

    const rows = await db
      .prepare("SELECT outcome, failure_reason, user_id, metadata FROM auth_audit_log WHERE event_type = 'signup' AND ip_hash = ?")
      .bind(await sha256Base64(ip))
      .all<{ outcome: string; failure_reason: string | null; user_id: string | null; metadata: string }>();
    const success = rows.results!.find((r) => r.outcome === 'success');
    const failure = rows.results!.find((r) => r.failure_reason === 'email_taken');
    expect(success!.user_id).toBe(userId);
    expect(failure).toBeTruthy();
    for (const r of rows.results!) expect(r.metadata).not.toContain(email);
  }, 30_000);
});

/**
 * V2 共編邀請：signup with invitationToken — 註冊成功後自動接受邀請（若 token valid +
 * email match）。失敗（過期 / mismatch）不擋 signup，response 含 invitationError。
 */
describe('POST /api/oauth/signup with invitationToken', () => {
  it('happy path: 201 + joinedTrip + trip_permissions + invitation accepted', async () => {
    const email = emailOf('invitee');
    const inv = await seedInvitation({ invitedEmail: email, expiresAt: future() });
    const res = await signup({ email, password: 'longenough', invitationToken: inv.raw });

    expect(res.status).toBe(201);
    const json = await res.json() as {
      userId: string;
      joinedTrip: { id: string; title: string } | null;
      invitationError: string | null;
    };
    expect(json.joinedTrip).toEqual({ id: inv.tripId, title: '沖繩 5 日' });
    expect(json.invitationError).toBeNull();

    const perm = await db.prepare('SELECT role FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
      .bind(inv.tripId, json.userId).first<{ role: string }>();
    expect(perm!.role).toBe('member');
    const accepted = await db.prepare('SELECT accepted_at, accepted_by FROM trip_invitations WHERE token_hash = ?')
      .bind(inv.hash).first<{ accepted_at: string | null; accepted_by: string | null }>();
    expect(accepted!.accepted_at).toBeTruthy();
    expect(accepted!.accepted_by).toBe(json.userId);
  }, 30_000);

  it('expired invitation: 201 signup success + invitationError=INVITATION_EXPIRED + joinedTrip=null', async () => {
    const email = emailOf('expired');
    const inv = await seedInvitation({ invitedEmail: email, expiresAt: past() });
    const res = await signup({ email, password: 'longenough', invitationToken: inv.raw });

    expect(res.status).toBe(201);
    const json = await res.json() as { userId: string; joinedTrip: unknown; invitationError: string };
    expect(json.joinedTrip).toBeNull();
    expect(json.invitationError).toBe('INVITATION_EXPIRED');
    const perm = await db.prepare('SELECT 1 AS x FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
      .bind(inv.tripId, json.userId).first();
    expect(perm).toBeNull();
    const row = await db.prepare('SELECT accepted_at FROM trip_invitations WHERE token_hash = ?')
      .bind(inv.hash).first<{ accepted_at: string | null }>();
    expect(row!.accepted_at).toBeNull();
  }, 30_000);

  it('email mismatch: 201 signup success + invitationError=INVITATION_EMAIL_MISMATCH + joinedTrip=null', async () => {
    const email = emailOf('mismatch');
    const inv = await seedInvitation({ invitedEmail: 'someone-else@x.com', expiresAt: future() });
    const res = await signup({ email, password: 'longenough', invitationToken: inv.raw });

    expect(res.status).toBe(201);
    const json = await res.json() as { userId: string; invitationError: string; joinedTrip: unknown };
    expect(json.invitationError).toBe('INVITATION_EMAIL_MISMATCH');
    expect(json.joinedTrip).toBeNull();
    const perm = await db.prepare('SELECT 1 AS x FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
      .bind(inv.tripId, json.userId).first();
    expect(perm).toBeNull();
  }, 30_000);

  it('invalid token: 201 signup success + invitationError=INVITATION_INVALID', async () => {
    const res = await signup({ email: emailOf('bogus'), password: 'longenough', invitationToken: 'bogus' });

    expect(res.status).toBe(201);
    const json = await res.json() as { invitationError: string };
    expect(json.invitationError).toBe('INVITATION_INVALID');
  }, 30_000);

  it('no invitationToken: backward compat — joinedTrip + invitationError both null/undefined', async () => {
    const email = emailOf('plain');
    const inv = await seedInvitation({ invitedEmail: email, expiresAt: future() });
    const res = await signup({ email, password: 'longenough' });

    expect(res.status).toBe(201);
    const json = await res.json() as { userId: string; joinedTrip: unknown; invitationError: unknown };
    expect(json.joinedTrip ?? null).toBeNull();
    expect(json.invitationError ?? null).toBeNull();

    // 沒帶 token 就不該動到既有邀請：仍未被接受、沒有權限列
    const row = await db.prepare('SELECT accepted_at FROM trip_invitations WHERE token_hash = ?')
      .bind(inv.hash).first<{ accepted_at: string | null }>();
    expect(row!.accepted_at).toBeNull();
    const perm = await db.prepare('SELECT 1 AS x FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
      .bind(inv.tripId, json.userId).first();
    expect(perm).toBeNull();
  }, 30_000);
});
