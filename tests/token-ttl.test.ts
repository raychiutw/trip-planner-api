/** T9：使用者授權（web／行動端）的 access token 15 分鐘；refresh 30 天；service（client_credentials）1 小時。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import { bearerAuth, requireAuth } from '../src/auth';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
let HASH: string;
const PASSWORD = 'correct-horse-battery';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const app = createApp();
app.use('/probe', bearerAuth, requireAuth);
app.get('/probe', (c) => c.json({ ok: true }));

beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  HASH ??= await hashPassword(PASSWORD);
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
  d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES ('u1', 'local', 'a@example.com', ?, 'pbkdf2')").run(HASH);
  d1.raw.prepare("INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status) VALUES ('svc', ?, 'confidential', 's', '[]', '[\"ops:read\"]', 'active')").run(HASH);
});
afterEach(() => { d1.close(); vi.useRealTimers(); });

async function login(): Promise<string> {
  const res = await app.request('/api/oauth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify({ email: 'a@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' }) }, env);
  return ((await res.json()) as { code: string }).code;
}
const token = (body: Record<string, string>) => app.request('/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' }, body: new URLSearchParams(body).toString() }, env);
const exchange = async () => token({ grant_type: 'authorization_code', client_id: 'tripline-web', code: await login(), code_verifier: VERIFIER });
const expiry = (name: string) => (d1.raw.prepare('SELECT expires_at FROM oauth_models WHERE name = ? ORDER BY expires_at DESC LIMIT 1').get(name) as { expires_at: number }).expires_at;
const secondsAhead = (ms: number) => Math.round((ms - Date.now()) / 1000);

describe('access token 存活時間', () => {
  it('authorization_code：回應 expires_in＝900，資料庫裡的到期時間也是 15 分鐘；refresh 是 30 天', async () => {
    const res = await exchange();
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(900);
    expect(Math.abs(secondsAhead(expiry('AccessToken')) - 900)).toBeLessThanOrEqual(3);
    expect(Math.abs(secondsAhead(expiry('RefreshToken')) - 30 * 24 * 3600)).toBeLessThanOrEqual(3);
  });

  it('refresh_token 輪替後的新 access token 同樣 15 分鐘', async () => {
    const first = await (await exchange()).json() as { refresh_token: string };
    const res = await token({ grant_type: 'refresh_token', client_id: 'tripline-web', refresh_token: first.refresh_token });
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(900);
  });

  it('client_credentials（service）維持 1 小時：長時間的自動化流程不會每 15 分鐘就失效', async () => {
    const res = await token({ grant_type: 'client_credentials', client_id: 'svc', client_secret: PASSWORD });
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(3600);
    expect(Math.abs(secondsAhead(expiry('AccessToken')) - 3600)).toBeLessThanOrEqual(3);
  });

  it('端到端：15 分鐘內可用，超過就 401（需要 refresh）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { access_token } = await (await exchange()).json() as { access_token: string };
    const probe = () => app.request('/probe', { headers: { Authorization: `Bearer ${access_token}` } }, env);
    expect((await probe()).status).toBe(200);
    vi.setSystemTime(Date.now() + 14 * 60_000);
    expect((await probe()).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await probe()).status).toBe(401);
  });
});
