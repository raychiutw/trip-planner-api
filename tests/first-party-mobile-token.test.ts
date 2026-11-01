import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';

const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const O = 'https://api.prod.test';
describe('第一方 mobile 密碼登入 → token（production 環境閘門不得擋掉沒有 redirect_uri 的 code）', () => {
  it('不帶 redirect_uri 換 token 應成功', async () => {
    const d1 = createD1();
    const env = { DB: d1.db, ALLOWED_ORIGINS: '', ENVIRONMENT: 'production', PUBLIC_ORIGIN: O } as Env;
    d1.raw.prepare('INSERT INTO users (id, email, status) VALUES (?, ?, ?)').run('u1', 'a@example.com', 'active');
    d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')").run('u1', 'a@example.com', await hashPassword('pw-pw-pw-pw-1'));
    const l = await createApp().request(`${O}/api/oauth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
      body: JSON.stringify({ email: 'a@example.com', password: 'pw-pw-pw-pw-1', client_id: 'tripline-mobile', code_challenge: CHALLENGE, code_challenge_method: 'S256' }) }, env);
    expect(l.status).toBe(200);
    const code = ((await l.json()) as { code: string }).code;
    const t = await createApp().request(`${O}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'tripline-mobile', code, code_verifier: VERIFIER }).toString() }, env);
    expect(t.status).toBe(200);
    d1.close();
  });
});
