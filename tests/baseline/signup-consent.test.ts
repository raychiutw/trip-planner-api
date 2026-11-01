// @vitest-environment node
/**
 * 註冊必須同意個資條款
 *
 * owner 決策（2026-07-20）：「保留資料，但建立帳號要客戶同意個資條款，
 * 如果刪除帳號會去識別化」。
 *
 * 這條的重點是**留下證據**：純前端勾選框擋不住直接打 API，也在 DB 裡留不下任何
 * 「這個人同意過」的紀錄。真被監管或爭議問起時，手上要有時間戳與版本。
 *
 * 版本要記的理由：政策改版後，沒有版本欄位就無法得知某個使用者當初同意的是哪一版。
 *
 * 走 HTTP 邊界（tests/api/http.ts）；稽核不存明文 email 改驗真實 D1 的 auth_audit_log，
 * 不再讀 handler 原始碼比對。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi } from './http';
import { sha256Base64 } from '../../src/lib/utils';

afterAll(async () => { await disposeMiniflare(); });

describe('POST /api/oauth/signup — 個資條款同意', () => {
  let db: D1Database;
  const emails: string[] = [];
  const ips: string[] = [];

  beforeAll(async () => { db = await createTestDb(); }, 30000);
  afterAll(async () => {
    for (const email of emails) {
      const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
      if (user) {
        await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(user.id).run();
        await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(user.id).run();
      }
      await db.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
    }
    for (const ip of ips) {
      await db.prepare('DELETE FROM auth_audit_log WHERE ip_hash = ?').bind(await sha256Base64(ip)).run();
      await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(`signup:${ip}`).run();
    }
  });

  let seq = 0;
  function post(body: Record<string, unknown>, ip = `10.88.0.${++seq}`): Promise<Response> {
    ips.push(ip);
    emails.push(String(body.email));
    return createApi({ env: mockEnv(db, { SESSION_SECRET: 'test-secret-32-chars-long-enough' } as never) })
      .request('POST', 'https://x.com/api/oauth/signup', {
        json: body,
        headers: { 'CF-Connecting-IP': ip },
      });
  }

  const valid = (email: string) => ({
    email, password: 'correct-horse-battery', displayName: 'Tester',
  });

  it('沒帶同意 → 拒絕建帳號', async () => {
    const email = 'signup-consent-no-consent@example.com';
    const res = await post(valid(email));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SIGNUP_CONSENT_REQUIRED');

    const row = await db.prepare('SELECT count(*) AS n FROM users WHERE email = ?')
      .bind(email).first<{ n: number }>();
    expect(row!.n, '未同意不得建立帳號').toBe(0);
  });

  it('同意欄位為 false → 一樣拒絕（不可只看欄位存在）', async () => {
    const email = 'signup-consent-false-consent@example.com';
    const res = await post({ ...valid(email), privacyConsent: false });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SIGNUP_CONSENT_REQUIRED');
  });

  it('同意 → 建帳號並記錄時間戳與政策版本', async () => {
    const email = 'signup-consent-consented@example.com';
    const res = await post({ ...valid(email), privacyConsent: true });
    expect(res.status).toBeLessThan(400);

    const row = await db
      .prepare('SELECT privacy_consent_at, privacy_policy_version FROM users WHERE email = ?')
      .bind(email)
      .first<{ privacy_consent_at: string | null; privacy_policy_version: string | null }>();

    expect(row, '帳號應已建立').not.toBeNull();
    expect(row!.privacy_consent_at, '必須留下同意時間戳').toBeTruthy();
    expect(row!.privacy_policy_version, '必須記錄同意的是哪一版政策').toBeTruthy();
  });
});

describe('signup 稽核紀錄不得存明文 email', () => {
  let db: D1Database;
  const email = 'signup-consent-audit@example.com';
  const ip = '10.88.1.1';

  beforeAll(async () => { db = await createTestDb(); }, 30000);
  afterAll(async () => {
    const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
    if (user) {
      await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(user.id).run();
      await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(user.id).run();
    }
    await db.prepare('DELETE FROM auth_audit_log WHERE ip_hash = ?').bind(await sha256Base64(ip)).run();
    await db.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(`signup:${ip}`).run();
  });

  it('email_taken 失敗路徑改存遮罩版', async () => {
    const api = createApi({ env: mockEnv(db, { SESSION_SECRET: 'test-secret-32-chars-long-enough' } as never) });
    const body = { email, password: 'correct-horse-battery', privacyConsent: true };
    const opts = { json: body, headers: { 'CF-Connecting-IP': ip } };
    expect((await api.request('POST', 'https://x.com/api/oauth/signup', opts)).status).toBe(201);
    expect((await api.request('POST', 'https://x.com/api/oauth/signup', opts)).status).toBe(409);

    const rows = await db
      .prepare("SELECT outcome, failure_reason, metadata FROM auth_audit_log WHERE event_type = 'signup' AND ip_hash = ?")
      .bind(await sha256Base64(ip))
      .all<{ outcome: string; failure_reason: string | null; metadata: string | null }>();
    const failure = rows.results!.find((r) => r.failure_reason === 'email_taken');
    expect(failure, 'email_taken 要有稽核紀錄').toBeTruthy();
    // metadata 若含明文 email 就會把個資寫進 auth_audit_log
    for (const r of rows.results!) expect(r.metadata ?? '').not.toContain(email);
  });
});
