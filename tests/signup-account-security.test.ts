/**
 * 註冊／驗證／忘記密碼／重設密碼的帳號安全守門（搬自舊入口後新增，不是舊測試的轉寫）。
 * 重點：帳號列舉面（回應一致）、寄信不阻塞回應（timing）、token 單次使用與過期、限流 key、密碼規則、email 內容。
 * 走 HTTP 邊界 + 真 SQLite；寄信一律以 stub 取代 fetch，不連線。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
let HASH: string;
let fetchStub: ReturnType<typeof vi.fn>;

const MAIL_ENV = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'stub-secret', SESSION_SECRET: 'session-secret-test-32-chars-long' };
const ok = () => new Response(JSON.stringify({ ok: true, messageId: 'm', elapsed: 1 }), { status: 200 });
const mailCalls = () => fetchStub.mock.calls.filter((c) => String(c[0]).includes('/internal/mail/send'));

beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '', ...MAIL_ENV } as unknown as Env;
  HASH ??= await hashPassword('old-password-123');
  fetchStub = vi.fn().mockResolvedValue(ok());
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => { d1.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function addUser(id: string, email: string, provider: 'local' | 'google' = 'local', verified = false) {
  d1.raw.prepare('INSERT INTO users (id, email, display_name, email_verified_at) VALUES (?, ?, ?, ?)').run(id, email, 'Alice', verified ? '2026-01-01T00:00:00Z' : null);
  if (provider === 'local') {
    d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')").run(id, email, HASH);
  } else {
    d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").run(id, `sub-${id}`);
  }
}
type Ctx = { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void };
function post(path: string, body: unknown, ip = '9.9.9.1', ctx?: Ctx) {
  return createApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  }, env, ctx as never);
}
/** 去掉每次不同的 request id，其餘標頭都要一致。 */
async function shape(res: Response) {
  const h = [...res.headers.entries()].filter(([k]) => !/request-id|^date$/i.test(k)).sort();
  return { status: res.status, body: await res.text(), headers: h };
}
const bucket = (key: string) => d1.raw.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').get(key) as { count: number } | undefined;
const models = (name: string) => d1.raw.prepare('SELECT id, payload FROM oauth_models WHERE name = ?').all(name) as { id: string; payload: string }[];

describe('forgot-password：帳號列舉面', () => {
  it('已註冊（local）、不存在、只有 Google 登入的 email：status／body／標頭逐字相同', async () => {
    addUser('u1', 'known@example.com');
    addUser('u2', 'g@example.com', 'google');
    const a = await shape(await post('/api/oauth/forgot-password', { email: 'known@example.com' }, '9.9.1.1'));
    const b = await shape(await post('/api/oauth/forgot-password', { email: 'nobody@example.com' }, '9.9.1.2'));
    const c = await shape(await post('/api/oauth/forgot-password', { email: 'g@example.com' }, '9.9.1.3'));
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.body).not.toContain('example.com');
  });

  it('只有 local 帳號會建 token 與寄信；不存在／Google-only 不建、不寄', async () => {
    addUser('u1', 'known@example.com');
    addUser('u2', 'g@example.com', 'google');
    await post('/api/oauth/forgot-password', { email: 'nobody@example.com' }, '9.9.2.1');
    await post('/api/oauth/forgot-password', { email: 'g@example.com' }, '9.9.2.2');
    expect(models('PasswordReset')).toHaveLength(0);
    expect(mailCalls()).toHaveLength(0);
    await post('/api/oauth/forgot-password', { email: 'known@example.com' }, '9.9.2.3');
    expect(models('PasswordReset')).toHaveLength(1);
    expect(mailCalls()).toHaveLength(1);
  });

  it('不論 email 存不存在，IP 與 email 兩個 bucket 都各 +1（限流 key 與舊入口相同）', async () => {
    addUser('u1', 'known@example.com');
    await post('/api/oauth/forgot-password', { email: 'known@example.com' }, '9.9.3.1');
    await post('/api/oauth/forgot-password', { email: 'nobody@example.com' }, '9.9.3.2');
    expect(bucket('forgot-password:9.9.3.1')?.count).toBe(1);
    expect(bucket('forgot-password:known@example.com')?.count).toBe(1);
    expect(bucket('forgot-password:9.9.3.2')?.count).toBe(1);
    expect(bucket('forgot-password:nobody@example.com')?.count).toBe(1);
  });

  it('被 email bucket 鎖住的回應，已註冊與不存在的 email 一樣（不洩漏存在與否）', async () => {
    addUser('u1', 'known@example.com');
    for (let i = 0; i < 4; i++) {
      await post('/api/oauth/forgot-password', { email: 'known@example.com' }, `9.9.4.${i}`);
      await post('/api/oauth/forgot-password', { email: 'nobody@example.com' }, `9.9.5.${i}`);
    }
    const a = await post('/api/oauth/forgot-password', { email: 'known@example.com' }, '9.9.4.99');
    const b = await post('/api/oauth/forgot-password', { email: 'nobody@example.com' }, '9.9.5.99');
    expect(a.status).toBe(429);
    const norm = async (r: Response) => { const s = await shape(r); return { ...s, headers: s.headers.filter(([k]) => k !== 'retry-after') }; };
    expect(await norm(b)).toEqual(await norm(a));
  });

  it('timing：寄信交給 waitUntil，不阻塞回應（mailer 卡住時仍立即回 200；不存在的 email 不排任何背景工作）', async () => {
    addUser('u1', 'known@example.com');
    fetchStub.mockImplementation(() => new Promise(() => { /* 永不回應 */ }));
    const queued: Promise<unknown>[] = [];
    const ctx: Ctx = { waitUntil: (p) => { queued.push(p); }, passThroughOnException: () => {} };
    const res = await Promise.race([
      post('/api/oauth/forgot-password', { email: 'known@example.com' }, '9.9.6.1', ctx),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    expect(res).not.toBe('timeout');
    expect((res as Response).status).toBe(200);
    expect(queued).toHaveLength(1);
    const none: Promise<unknown>[] = [];
    await post('/api/oauth/forgot-password', { email: 'nobody@example.com' }, '9.9.6.2', { waitUntil: (p) => { none.push(p); }, passThroughOnException: () => {} });
    expect(none).toHaveLength(0);
  });

  it('email 內容：重設連結含一次性 token，且不含密碼雜湊、使用者 id', async () => {
    addUser('u1', 'known@example.com');
    await post('/api/oauth/forgot-password', { email: 'known@example.com' }, '9.9.7.1');
    const sent = JSON.stringify(mailCalls()[0]![1]);
    const token = models('PasswordReset')[0]!.id;
    expect(sent).toContain(encodeURIComponent(token));
    expect(sent).not.toContain(HASH);
    expect(sent).not.toContain('"u1"');
    expect(sent).toContain('/auth/password/reset?token=');
  });
});

describe('send-verification：帳號列舉面', () => {
  it('未驗證、已驗證、不存在：回應逐字相同；只有未驗證者建 token 與寄信', async () => {
    addUser('u1', 'unverified@example.com', 'local', false);
    addUser('u2', 'verified@example.com', 'local', true);
    const a = await shape(await post('/api/oauth/send-verification', { email: 'unverified@example.com' }, '9.8.1.1'));
    const b = await shape(await post('/api/oauth/send-verification', { email: 'verified@example.com' }, '9.8.1.2'));
    const c = await shape(await post('/api/oauth/send-verification', { email: 'nobody@example.com' }, '9.8.1.3'));
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(models('EmailVerification')).toHaveLength(1);
    expect(mailCalls()).toHaveLength(1);
  });
  it('timing：mailer 卡住也不阻塞回應', async () => {
    addUser('u1', 'unverified@example.com');
    fetchStub.mockImplementation(() => new Promise(() => {}));
    const queued: Promise<unknown>[] = [];
    const res = await Promise.race([
      post('/api/oauth/send-verification', { email: 'unverified@example.com' }, '9.8.2.1', { waitUntil: (p) => { queued.push(p); }, passThroughOnException: () => {} }),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    expect(res).not.toBe('timeout');
    expect(queued).toHaveLength(1);
  });
});

describe('signup：回應與限流', () => {
  const base = { email: 'new@example.com', password: 'a-secure-password-1', privacyConsent: true };
  it('已註冊 email 回 409 SIGNUP_EMAIL_TAKEN（與舊入口相同的已知列舉面；此測試把現況固定下來），且不洩漏既有帳號資料', async () => {
    addUser('u1', 'taken@example.com');
    const res = await post('/api/oauth/signup', { ...base, email: 'taken@example.com' }, '9.7.1.1');
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('SIGNUP_EMAIL_TAKEN');
    expect(text).not.toContain('u1');
    expect(text).not.toContain('Alice');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('email 已被註冊的嘗試也計入 IP 限流（key signup:<ip>），超過 10 次後 429', async () => {
    addUser('u1', 'taken@example.com');
    for (let i = 0; i < 11; i++) expect((await post('/api/oauth/signup', { ...base, email: 'taken@example.com' }, '9.7.2.1')).status).toBe(409);
    expect(bucket('signup:9.7.2.1')?.count).toBe(11);
    expect((await post('/api/oauth/signup', { ...base, email: 'taken@example.com' }, '9.7.2.1')).status).toBe(429);
  });
  it('密碼規則：7 字元拒絕且不建帳號；8 字元通過；未同意個資條款不建帳號也不耗限流', async () => {
    const short = await post('/api/oauth/signup', { ...base, password: '1234567' }, '9.7.3.1');
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: { code: string } }).error.code).toBe('SIGNUP_PASSWORD_TOO_SHORT');
    expect(d1.raw.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    expect((await post('/api/oauth/signup', { ...base, password: '12345678' }, '9.7.3.2')).status).toBe(201);
    expect((await post('/api/oauth/signup', { ...base, email: 'other@example.com', privacyConsent: 'true' }, '9.7.3.3')).status).toBe(400);
    expect(bucket('signup:9.7.3.3')).toBeUndefined();
  });
  it('註冊成功不發任何登入憑證，之後用 /api/oauth/login 可換 code（改寫自舊入口的「註冊後自動登入」）', async () => {
    const res = await post('/api/oauth/signup', base, '9.7.4.1');
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(models('AccessToken')).toHaveLength(0);
    const hash = d1.raw.prepare("SELECT password_hash FROM auth_identities WHERE provider = 'local'").get() as { password_hash: string };
    expect(hash.password_hash).not.toContain(base.password);
    expect(await verifyPassword(base.password, hash.password_hash)).toBe(true);
    const login = await post('/api/oauth/login', { email: base.email, password: base.password, client_id: 'tripline-web', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' }, '9.7.4.2');
    expect(login.status).toBe(200);
    expect(await login.json()).toHaveProperty('code');
  });
});

describe('reset-password：token 與密碼規則', () => {
  function seedToken(id: string, userId: string, email: string, over: { expiresAt?: number; consumed?: number } = {}) {
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('PasswordReset', ?, ?, ?)").run(
      id, JSON.stringify({ userId, email, createdAt: Date.now(), ...(over.consumed ? { consumed: over.consumed } : {}) }), over.expiresAt ?? Date.now() + 600_000);
  }
  const hashOf = (id: string) => (d1.raw.prepare("SELECT password_hash h FROM auth_identities WHERE user_id = ? AND provider = 'local'").get(id) as { h: string }).h;

  it('已過期的 token 被拒、密碼不變；有效 token 成功一次後再用被拒（單次使用）', async () => {
    addUser('u1', 'a@example.com');
    seedToken('expired-tok', 'u1', 'a@example.com', { expiresAt: Date.now() - 1000 });
    const r1 = await post('/api/oauth/reset-password', { token: 'expired-tok', password: 'brand-new-pass-1' }, '9.6.1.1');
    expect(r1.status).toBe(400);
    expect(hashOf('u1')).toBe(HASH);
    seedToken('good-tok', 'u1', 'a@example.com');
    expect((await post('/api/oauth/reset-password', { token: 'good-tok', password: 'brand-new-pass-1' }, '9.6.1.2')).status).toBe(200);
    const after = hashOf('u1');
    expect((await post('/api/oauth/reset-password', { token: 'good-tok', password: 'attacker-pass-99' }, '9.6.1.3')).status).toBe(400);
    expect(hashOf('u1')).toBe(after);
  });
  it('密碼規則：7 字元拒絕且 token 不被消耗；8 字元通過', async () => {
    addUser('u1', 'a@example.com');
    seedToken('tok', 'u1', 'a@example.com');
    const short = await post('/api/oauth/reset-password', { token: 'tok', password: '1234567' }, '9.6.2.1');
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: { code: string } }).error.code).toBe('RESET_PASSWORD_TOO_SHORT');
    expect(JSON.parse(models('PasswordReset')[0]!.payload).consumed).toBeUndefined();
    expect((await post('/api/oauth/reset-password', { token: 'tok', password: '12345678' }, '9.6.2.2')).status).toBe(200);
  });
  it('token 屬於哪個使用者就只改那個人的密碼', async () => {
    addUser('u1', 'a@example.com');
    addUser('u2', 'b@example.com');
    seedToken('tok', 'u1', 'a@example.com');
    await post('/api/oauth/reset-password', { token: 'tok', password: 'brand-new-pass-1' }, '9.6.3.1');
    expect(hashOf('u1')).not.toBe(HASH);
    expect(hashOf('u2')).toBe(HASH);
  });
  it('限流 key reset-password:<ip>：連續亂猜 token 超過 5 次後鎖定，之後連處理都不做', async () => {
    for (let i = 0; i < 6; i++) expect((await post('/api/oauth/reset-password', { token: `bad-${i}`, password: 'brand-new-pass-1' }, '9.6.4.1')).status).toBe(400);
    expect(bucket('reset-password:9.6.4.1')?.count).toBe(6);
    expect((await post('/api/oauth/reset-password', { token: 'bad-x', password: 'brand-new-pass-1' }, '9.6.4.1')).status).toBe(429);
  });
  it('確認信不含新密碼', async () => {
    addUser('u1', 'a@example.com');
    seedToken('tok', 'u1', 'a@example.com');
    await post('/api/oauth/reset-password', { token: 'tok', password: 'brand-new-pass-1' }, '9.6.5.1');
    expect(mailCalls()).toHaveLength(1);
    expect(JSON.stringify(mailCalls()[0]![1])).not.toContain('brand-new-pass-1');
  });
});

describe('verify：token 單次使用與過期', () => {
  function seedVerify(id: string, userId: string, over: { expiresAt?: number; consumed?: number } = {}) {
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('EmailVerification', ?, ?, ?)").run(
      id, JSON.stringify({ userId, email: 'x', createdAt: Date.now(), ...(over.consumed ? { consumed: over.consumed } : {}) }), over.expiresAt ?? Date.now() + 600_000);
  }
  const verifiedAt = (id: string) => (d1.raw.prepare('SELECT email_verified_at v FROM users WHERE id = ?').get(id) as { v: string | null }).v;
  it('過期 → expired 且不標記驗證；成功後再用 → used；驗證不發 cookie', async () => {
    addUser('u1', 'a@example.com');
    seedVerify('old', 'u1', { expiresAt: Date.now() - 1000 });
    const r0 = await post('/api/oauth/verify', { token: 'old' });
    expect(r0.status).toBe(400);
    expect(await r0.json()).toEqual({ error: 'expired' });
    expect(verifiedAt('u1')).toBeNull();
    seedVerify('good', 'u1');
    const r1 = await post('/api/oauth/verify', { token: 'good' });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    expect(r1.headers.get('set-cookie')).toBeNull();
    expect(verifiedAt('u1')).not.toBeNull();
    const r2 = await post('/api/oauth/verify', { token: 'good' });
    expect(await r2.json()).toEqual({ error: 'used' });
  });
});

describe('share 管理端點：匿名一律 401', () => {
  it('匿名 PATCH／DELETE／GET／POST /api/trips/:id/shares* 都是 401', async () => {
    const call = (method: string, path: string) => createApp().request(path, { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '9.5.0.1' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' }, env);
    for (const [m, p] of [['GET', '/api/trips/t1/shares'], ['POST', '/api/trips/t1/shares'], ['PATCH', '/api/trips/t1/shares/1'], ['DELETE', '/api/trips/t1/shares/1'], ['POST', '/api/share/anything/clone']] as const) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
    }
  });
});
