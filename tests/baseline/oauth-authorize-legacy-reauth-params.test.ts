/**
 * 重新驗證模式已移除（ADR-0019）：舊版 App 仍可能帶 prompt=login、biometric_intent、expected_account。
 * 這些參數一律忽略、不報錯：授權照一般流程完成，導回網址不帶任何重新驗證旗標；
 * web 登入頁按鈕記下的 enable 意圖照常由 server 在導回時加上 biometric_intent=enable。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { peekAuthRequest } from '../../src/lib/auth-request';
import type { Env } from '../../src/env';

const CLIENT = 'h3-legacy-reauth-partner';
const CB = 'https://x.com/cb';
const WEB = 'https://web.example';
const EMAIL = 'h3-legacy-reauth-user@example.com';
const OTHER = 'h3-legacy-reauth-other@example.com';
const PKCE = { code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256' };
const BASE = '/api/oauth/authorize/requests';
const VALID = { client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid', state: 'st-1', ...PKCE };

/** 舊版 App 可能帶的重新驗證參數組合（含格式錯誤的 expected_account，以前會回 invalid_request）。 */
const LEGACY: Record<string, string>[] = [
  { prompt: 'login' },
  { prompt: 'login', biometric_intent: 'enable', expected_account: userIdFor(EMAIL) },
  { prompt: 'login', biometric_intent: 'disable', expected_account: userIdFor(EMAIL) },
  { prompt: 'login', biometric_intent: 'disable', expected_account: 'has space' },
  { prompt: 'login', biometric_intent: 'enable' },
];

let db: D1Database;
let api: Api;

const CLEAN = `DELETE FROM oauth_models WHERE name IN ('AuthRequest', 'Consent', 'AuthorizationCode') AND json_extract(payload, '$.client_id') = '${CLIENT}'`;

const authorizeUrl = (params: Record<string, string>) => `https://x.com/api/oauth/authorize?${new URLSearchParams({ ...VALID, ...params })}`;
async function location(params: Record<string, string>): Promise<URL> {
  const res = await api.get(authorizeUrl(params));
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!);
}
const start = async (params: Record<string, string>) => (await location(params)).searchParams.get('request_id')!;
const decide = (id: string, as: string, path = 'approve') => api.request('POST', `${BASE}/${id}/${path}`, { as, json: {} });
const redirectTo = async (res: Response) => new URL(((await res.json()) as { redirect_to: string }).redirect_to);

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { WEB_ORIGIN: WEB } as Partial<Env>) });
  await db.prepare(`INSERT OR REPLACE INTO client_apps
    (client_id, client_type, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, 'public', 'Partner App', ?, ?, 'active')`)
    .bind(CLIENT, JSON.stringify([CB]), JSON.stringify(['openid'])).run();
});
beforeEach(async () => { await db.prepare(CLEAN).run(); });
afterAll(async () => {
  await db.prepare(CLEAN).run();
  await db.prepare('DELETE FROM client_apps WHERE client_id = ?').bind(CLIENT).run();
  await db.prepare('DELETE FROM auth_audit_log WHERE client_id = ?').bind(CLIENT).run();
  await disposeMiniflare();
});

describe('舊的重新驗證參數一律忽略', () => {
  it.each(LEGACY)('authorize %j → 導向 web 授權頁，網址只有 request_id，授權請求不記重新驗證欄位', async (params) => {
    const loc = await location(params);
    expect(loc.origin).toBe(WEB);
    expect([...loc.searchParams.keys()]).toEqual(['request_id']);
    const stored = await peekAuthRequest(db, loc.searchParams.get('request_id')!);
    expect(stored).toBeDefined();
    expect(stored!.payload).not.toHaveProperty('reauth_intent');
    expect(stored!.payload).not.toHaveProperty('expected_account');
  });

  it.each(LEGACY)('authorize %j → 任何帳號以一般登入批准（不需剛用密碼登入）→ 只有 code 與 state', async (params) => {
    const id = await start(params);
    const res = await decide(id, OTHER);
    expect(res.status).toBe(200);
    const loc = await redirectTo(res);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect([...loc.searchParams.keys()].sort()).toEqual(['code', 'state']);
  });

  it('web 登入頁按鈕記下 enable 意圖 → 批准時照常帶 biometric_intent=enable（帶舊參數的請求也一樣）', async () => {
    const id = await start({ prompt: 'login', biometric_intent: 'disable', expected_account: userIdFor(EMAIL) });
    expect((await api.request('POST', `${BASE}/${id}/intent`, { as: EMAIL, json: { intent: 'enable' } })).status).toBe(204);
    const loc = await redirectTo(await decide(id, EMAIL));
    expect(loc.searchParams.get('biometric_intent')).toBe('enable');
    expect(loc.searchParams.get('code')).toBeTruthy();
  });

  it('意圖端點不再接受 disable（只剩 enable 與 null）', async () => {
    const id = await start({});
    expect((await api.request('POST', `${BASE}/${id}/intent`, { as: EMAIL, json: { intent: 'disable' } })).status).toBe(400);
    expect((await redirectTo(await decide(id, EMAIL))).searchParams.has('biometric_intent')).toBe(false);
  });
});
