/**
 * /api/oauth/verify + /api/oauth/send-verification — V2-P2 email verification
 * 走 HTTP 邊界（tests/api/http.ts）；原本檢查 mock DB 呼叫形狀的斷言，改讀真實 D1 的資料變化
 * （users.email_verified_at、oauth_models 的 EmailVerification token、audit_log、rate_limit_buckets）。
 * 寄信走 mac mini mailer 的 fetch，是外部邊界，用 vi.stubGlobal 攔截並斷言寄出內容。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';

const PREFIX = 'oauth-verify-test';
const emailOf = (name: string) => `${PREFIX}-${name}@x.com`;
const MAILER = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'test-bearer' };

let db: D1Database;
let seq = 0;
const userIds: string[] = [];
const tokenIds: string[] = [];
const bucketKeys: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const id of tokenIds) await db.prepare("DELETE FROM oauth_models WHERE name = 'EmailVerification' AND id = ?").bind(id).run();
  for (const id of userIds) {
    await db.prepare("DELETE FROM oauth_models WHERE name = 'EmailVerification' AND json_extract(payload, '$.userId') = ?").bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await db.prepare("DELETE FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?").bind(`%${PREFIX}%`).run();
  for (const k of bucketKeys) await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(k).run();
  await disposeMiniflare();
});

const api = (extra: Record<string, unknown> = {}) => createApi({ env: mockEnv(db, extra as never) });

async function seedUser(name: string, verified = false) {
  const id = `${PREFIX}-${name}-${++seq}`;
  const email = emailOf(`${name}-${seq}`);
  await db
    .prepare('INSERT INTO users (id, email, display_name, email_verified_at) VALUES (?, ?, ?, ?)')
    .bind(id, email, name, verified ? new Date().toISOString() : null)
    .run();
  userIds.push(id);
  return { id, email };
}

async function seedToken(userId: string, email: string, opts: { expiresAt?: number; consumed?: number } = {}) {
  const id = `${PREFIX}-token-${++seq}`;
  const payload = { userId, email, createdAt: Date.now() - 1000, ...(opts.consumed ? { consumed: opts.consumed } : {}) };
  await db
    .prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('EmailVerification', ?, ?, ?)")
    .bind(id, JSON.stringify(payload), opts.expiresAt ?? Date.now() + 60_000)
    .run();
  tokenIds.push(id);
  return id;
}

const verifiedAt = async (userId: string) =>
  (await db.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind(userId).first<{ email_verified_at: string | null }>())!.email_verified_at;

const tokenRow = (id: string) =>
  db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'EmailVerification' AND id = ?").bind(id)
    .first<{ payload: string; expires_at: number }>();

describe('GET /api/oauth/verify', () => {
  it('302 → /login?verify_error=missing_token when token query absent', async () => {
    const res = await api().get('https://x.com/api/oauth/verify?');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?verify_error=missing_token');
  });

  it('302 → /login?verify_error=expired when token not found', async () => {
    const res = await api().get('https://x.com/api/oauth/verify?token=fake-token');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?verify_error=expired');
  });

  it('302 → /login?verified=1 happy path + users.email_verified_at 寫入 + token 標為已使用', async () => {
    const u = await seedUser('happy');
    const token = await seedToken(u.id, u.email);
    const res = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?verified=1');

    expect(await verifiedAt(u.id)).toBeTruthy();
    // token 標記 consumed 但不刪除 —— 保留到 expires_at，重點連結才會回 'used'
    const row = await tokenRow(token);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.payload).consumed).toBeTruthy();
  });

  it('302 → /login?verify_error=used when token already consumed (re-click)', async () => {
    const u = await seedUser('reclick');
    const token = await seedToken(u.id, u.email, { consumed: Date.now() - 100 });
    const res = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?verify_error=used');
    // 不得動到 users
    expect(await verifiedAt(u.id)).toBeNull();
  });

  it('同一個 token 連點兩次：第一次成功、第二次回 used（不可重複使用）', async () => {
    const u = await seedUser('twice');
    const token = await seedToken(u.id, u.email);
    const first = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
    expect(first.headers.get('Location')).toBe('/login?verified=1');
    const second = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
    expect(second.headers.get('Location')).toBe('/login?verify_error=used');
  });

  it('302 → /login?verify_error=expired when token expired (D1Adapter.find returns null)', async () => {
    const u = await seedUser('expired');
    const token = await seedToken(u.id, u.email, { expiresAt: Date.now() - 60_000 });
    const res = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
    expect(res.headers.get('Location')).toBe('/login?verify_error=expired');
    expect(await verifiedAt(u.id)).toBeNull();
  });

  it('does NOT consume token if UPDATE fails (so user can retry)', async () => {
    const u = await seedUser('dbfail');
    const token = await seedToken(u.id, u.email);
    // 在真實 D1 注入故障：該使用者的 email_verified_at 更新一律中止
    const trigger = `${PREFIX.replace(/-/g, '_')}_block_${seq}`;
    await db.prepare(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE OF email_verified_at ON users WHEN NEW.id = '${u.id}'
       BEGIN SELECT RAISE(ABORT, 'DB unavailable'); END`,
    ).run();
    try {
      const res = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login?verify_error=server_error');
    } finally {
      await db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    }

    // token 沒被消耗（保留給使用者重試），且之後重試可成功
    expect(JSON.parse((await tokenRow(token))!.payload).consumed).toBeUndefined();
    const retry = await api().get(`https://x.com/api/oauth/verify?token=${token}`);
    expect(retry.headers.get('Location')).toBe('/login?verified=1');
  });

  it('POST（SPA 主要路徑）：成功回 200 { ok }；缺 token 400；重送回 used 400', async () => {
    const u = await seedUser('post');
    const token = await seedToken(u.id, u.email);
    const ok = await api().request('POST', 'https://x.com/api/oauth/verify', { json: { token } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(await verifiedAt(u.id)).toBeTruthy();

    const again = await api().request('POST', 'https://x.com/api/oauth/verify', { json: { token } });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'used' });

    const missing = await api().request('POST', 'https://x.com/api/oauth/verify', { json: {} });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'missing_token' });
  });
});

describe('POST /api/oauth/send-verification', () => {
  function freshIp(): string {
    const ip = `10.66.0.${++seq}`;
    bucketKeys.push(`send-verification:${ip}`);
    return ip;
  }

  async function send(body: unknown, env: Record<string, unknown> = {}) {
    if (body && typeof body === 'object' && 'email' in body) {
      bucketKeys.push(`send-verification:${String((body as { email: string }).email).trim().toLowerCase()}`);
    }
    return api(env).request('POST', 'https://x.com/api/oauth/send-verification', {
      json: body,
      headers: { 'CF-Connecting-IP': freshIp() },
    });
  }

  const tokensFor = async (userId: string) =>
    (await db
      .prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'EmailVerification' AND json_extract(payload, '$.userId') = ?")
      .bind(userId)
      .all<{ id: string; payload: string; expires_at: number }>()).results!;

  const mailerStub = (response: Response) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const okMail = () => new Response(JSON.stringify({ ok: true, messageId: 'msg-test', elapsed: 100 }), { status: 200 });
  const mailerCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/internal/mail/send'));

  it('200 generic response when email empty (no enum leak)', async () => {
    const res = await send({});
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('若帳號');
  });

  it('200 generic when email not found (no enum leak)', async () => {
    const fetchMock = mailerStub(okMail());
    const res = await send({ email: emailOf('nobody') }, MAILER);
    expect(res.status).toBe(200);
    // 使用者不存在 → 不產 token、不寄信
    expect(mailerCalls(fetchMock)).toHaveLength(0);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'EmailVerification' AND json_extract(payload, '$.email') = ?")
      .bind(emailOf('nobody')).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('200 generic when email already verified (silent no-op)', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('verified', true);
    const res = await send({ email: u.email }, MAILER);
    expect(res.status).toBe(200);
    expect(await tokensFor(u.id)).toHaveLength(0);
    expect(mailerCalls(fetchMock)).toHaveLength(0);
  });

  it('200 + 寫入 EmailVerification token（24h TTL）when email is unverified user', async () => {
    mailerStub(okMail());
    const u = await seedUser('unverified');
    const before = Date.now();
    const res = await send({ email: u.email }, MAILER);
    const after = Date.now();
    expect(res.status).toBe(200);

    const tokens = await tokensFor(u.id);
    expect(tokens).toHaveLength(1);
    expect(JSON.parse(tokens[0]!.payload)).toMatchObject({ userId: u.id, email: u.email });
    const ttl = 24 * 60 * 60 * 1000;
    expect(tokens[0]!.expires_at).toBeGreaterThanOrEqual(before + ttl);
    expect(tokens[0]!.expires_at).toBeLessThanOrEqual(after + ttl);
  });

  it('只有未驗證的使用者會拿到 token；已驗證者同網域的未驗證者不受影響', async () => {
    mailerStub(okMail());
    const verified = await seedUser('filter-verified', true);
    const unverified = await seedUser('filter-unverified');
    await send({ email: verified.email }, MAILER);
    await send({ email: unverified.email }, MAILER);
    expect(await tokensFor(verified.id)).toHaveLength(0);
    expect(await tokensFor(unverified.id)).toHaveLength(1);
  });

  it('email lowercase + trim before lookup', async () => {
    mailerStub(okMail());
    const u = await seedUser('mixed');
    const res = await send({ email: `  ${u.email.toUpperCase()}  ` }, MAILER);
    expect(res.status).toBe(200);
    expect(await tokensFor(u.id)).toHaveLength(1);
  });

  it('sends verification email via mac mini tunnel (post-2026-05-02 cutover)', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('mailer');
    await send({ email: u.email }, MAILER);

    const calls = mailerCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(`${MAILER.TRIPLINE_API_URL}/internal/mail/send`);
    const init = calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-bearer');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.to).toBe(u.email);
    expect(body.subject).toContain('驗證');
    // v2.33.59 round 13 H2: email link 改指 SPA landing /auth/verify-email，帶的是剛寫入 D1 的 token
    const [stored] = await tokensFor(u.id);
    expect(body.html).toContain(`/auth/verify-email?token=${encodeURIComponent(stored!.id)}`);
    expect(body.template).toBe('verification');

    // 寄出成功要留 audit
    const audit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`)
      .first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ template: 'verification', recipient: u.email, status: 'sent' });
  });

  it('200 generic + audit when TRIPLINE_API_URL missing (v2.33.59 round 13: background send anti-enum)', async () => {
    const fetchMock = mailerStub(okMail());
    const u = await seedUser('nourl');
    const res = await send({ email: u.email });
    // 改 background send，response 永遠 200 generic (anti-enum)；失敗只記 audit
    expect(res.status).toBe(200);

    const audit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`)
      .first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ status: 'failed', recipient: u.email });
    // sendEmail 在缺 TRIPLINE_API_URL 時，fetch 之前就丟錯
    expect(mailerCalls(fetchMock)).toHaveLength(0);
  });

  it('200 generic + audit when mac mini mailer fails (v2.33.59 round 13: silent failure)', async () => {
    mailerStub(new Response(JSON.stringify({ error: 'SMTP unreachable' }), { status: 500 }));
    const u = await seedUser('mailfail');
    const res = await send({ email: u.email }, MAILER);
    // 200 generic even on mailer failure
    expect(res.status).toBe(200);
    const audit = await db
      .prepare("SELECT diff_json FROM audit_log WHERE table_name = 'email' AND diff_json LIKE ?")
      .bind(`%${u.email}%`)
      .first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ status: 'failed' });
  });

  it('429 VERIFY_RATE_LIMITED when the same email is requested more than 3 times in an hour', async () => {
    mailerStub(okMail());
    const u = await seedUser('limited');
    for (let i = 0; i < 4; i++) expect((await send({ email: u.email }, MAILER)).status).toBe(200);
    const res = await send({ email: u.email }, MAILER);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VERIFY_RATE_LIMITED');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
