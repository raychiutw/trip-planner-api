/**
 * 設定頁「開啟／關閉生物辨識登入」的重新驗證授權（ADR-0018）：prompt=login + biometric_intent + expected_account。
 * 重點：帳號不符或不是剛用密碼登入 → 不產生授權碼；一般授權完全不受影響；網址只出現白名單值。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import type { Env } from '../../src/env';

const CLIENT = 'h2-reauth-partner';
const CB = 'https://x.com/cb';
const WEB = 'https://web.example';
const EMAIL = 'h2-reauth-user@example.com';
const OTHER = 'h2-reauth-other@example.com';
const PKCE = { code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256' };
const BASE = '/api/oauth/authorize/requests';
const VALID = { client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid', state: 'st-1', ...PKCE };
const REAUTH = { prompt: 'login', biometric_intent: 'enable', expected_account: userIdFor(EMAIL) };

let db: D1Database;
let api: Api;

const CLEAN = "DELETE FROM oauth_models WHERE (name = 'AuthRequest' AND json_extract(payload, '$.client_id') = 'h2-reauth-partner') OR (name IN ('Consent', 'AuthorizationCode') AND json_extract(payload, '$.client_id') = 'h2-reauth-partner') OR (name = 'AuthorizationCode' AND id LIKE 'h2-login-%')";

const authorizeUrl = (params: Record<string, string>) => `https://x.com/api/oauth/authorize?${new URLSearchParams({ ...VALID, ...params })}`;
async function location(params: Record<string, string> = {}): Promise<URL> {
  const res = await api.get(authorizeUrl(params));
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!);
}
const start = async (params: Record<string, string> = REAUTH) => (await location(params)).searchParams.get('request_id')!;

/** 模擬「剛用密碼登入」：該 grant 的 /api/oauth/login code（redirect_uri 為 null、60 秒 TTL）仍在。 */
async function freshBearer(email: string): Promise<string> {
  const token = await api.tokenFor(email);
  await new D1Adapter(db, 'AuthorizationCode').upsert(`h2-login-${token}`, {
    client_id: 'http-test', user_id: userIdFor(email), redirect_uri: null, scopes: [], grantId: `grant-${token}`, consumed: Date.now(),
  }, 60);
  return token;
}
const decide = (id: string, bearer: string, path = 'approve') => api.request('POST', `${BASE}/${id}/${path}`, { bearer, json: {} });
const codeCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.client_id') = ?").bind(CLIENT).first<{ n: number }>())!.n;

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
  await db.prepare("DELETE FROM client_apps WHERE client_id = 'h2-reauth-partner'").run();
  await db.prepare("DELETE FROM auth_audit_log WHERE client_id = 'h2-reauth-partner'").run();
  await disposeMiniflare();
});

describe('302 Location 的 reauth（顯示用）', () => {
  it.each(['enable', 'disable'])('prompt=login + biometric_intent=%s + expected_account → 多 reauth', async (intent) => {
    const loc = await location({ ...REAUTH, biometric_intent: intent });
    expect([...loc.searchParams.keys()].sort()).toEqual(['reauth', 'request_id']);
    expect(loc.searchParams.get('reauth')).toBe(intent);
    expect(loc.search).not.toContain(userIdFor(EMAIL));
  });

  it('單獨 prompt=login（沒有意圖、沒有 expected_account）→ reauth=login，不記 reauth_intent', async () => {
    const loc = await location({ prompt: 'login' });
    expect([...loc.searchParams.keys()].sort()).toEqual(['reauth', 'request_id']);
    expect(loc.searchParams.get('reauth')).toBe('login');
    const row = await db.prepare("SELECT json_extract(payload, '$.reauth_intent') AS i FROM oauth_models WHERE name = 'AuthRequest' AND id = ?").bind(loc.searchParams.get('request_id')).first<{ i: unknown }>();
    expect(row!.i).toBeNull();
  });

  it('單獨 prompt=login 帶了未知意圖／expected_account → 仍只有 reauth=login，網址不含其值', async () => {
    const loc = await location({ prompt: 'login', biometric_intent: 'delete-all', expected_account: 'x&y=https://evil.test' });
    expect(loc.searchParams.get('reauth')).toBe('login');
    expect(loc.search).not.toMatch(/evil|delete/);
  });

  it('與 biometric_hint 並存', async () => {
    const loc = await location({ ...REAUTH, biometric_hint: 'faceid' });
    expect([...loc.searchParams.keys()].sort()).toEqual(['biometric_hint', 'reauth', 'request_id']);
  });

  it('一般授權（沒有 prompt=login）→ 只有 request_id，也不記 reauth', async () => {
    for (const p of [{} as Record<string, string>, { biometric_intent: 'enable', expected_account: userIdFor(EMAIL) }, { prompt: 'consent', biometric_intent: 'enable', expected_account: userIdFor(EMAIL) }]) {
      const loc = await location(p);
      expect([...loc.searchParams.keys()]).toEqual(['request_id']);
      const row = await db.prepare("SELECT json_extract(payload, '$.reauth_intent') AS i FROM oauth_models WHERE name = 'AuthRequest' AND id = ?").bind(loc.searchParams.get('request_id')).first<{ i: unknown }>();
      expect(row!.i).toBeNull();
    }
  });

  it.each([['delete-all'], [''], ['ENABLE'], ['enable&x=https://evil.test']])('未知意圖 %j → 當作沒帶（退為單獨 prompt=login），reauth 只會是 login，網址沒有該值', async (intent) => {
    const loc = await location({ ...REAUTH, biometric_intent: intent });
    expect([...loc.searchParams.keys()].sort()).toEqual(['reauth', 'request_id']);
    expect(loc.searchParams.get('reauth')).toBe('login');
    expect(loc.search).not.toMatch(/evil|delete/);
  });

  it.each([[''], ['has space'], ['a'.repeat(65)], ['x&y=1'], ['../etc']])('有意圖但 expected_account %j 不合法 → 302 回 client invalid_request，不建授權請求', async (acc) => {
    const loc = await location({ ...REAUTH, expected_account: acc });
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(loc.searchParams.has('request_id')).toBe(false);
  });

  it('有意圖但沒帶 expected_account → 同樣 invalid_request', async () => {
    const { expected_account: _drop, ...noAcc } = REAUTH;
    expect((await location(noAcc)).searchParams.get('error')).toBe('invalid_request');
  });
});

describe('approve 的重新驗證', () => {
  it.each(['enable', 'disable'])('帳號相符且剛密碼登入 → 發 code，redirect_to 帶 biometric_intent=%s', async (intent) => {
    const id = await start({ ...REAUTH, biometric_intent: intent });
    const res = await decide(id, await freshBearer(EMAIL));
    expect(res.status).toBe(200);
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('biometric_intent')).toBe(intent);
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('st-1');
  });

  it('帳號不符 → 200 redirect_to 帶 error=reauth_account_mismatch 與 state，不帶 code／biometric_intent；不寫同意，請求被燒掉', async () => {
    const id = await start();
    const res = await decide(id, await freshBearer(OTHER));
    expect(res.status).toBe(200);
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect([...loc.searchParams.keys()].sort()).toEqual(['error', 'state']);
    expect(loc.searchParams.get('error')).toBe('reauth_account_mismatch');
    expect(loc.searchParams.get('state')).toBe('st-1');
    expect(await codeCount()).toBe(0);
    const consent = await db.prepare("SELECT 1 AS x FROM oauth_models WHERE name = 'Consent' AND json_extract(payload, '$.client_id') = ?").bind(CLIENT).first();
    expect(consent).toBeNull();
    const audit = await db.prepare("SELECT outcome, failure_reason FROM auth_audit_log WHERE client_id = ? AND failure_reason = 'reauth_account_mismatch'").bind(CLIENT).first<{ outcome: string }>();
    expect(audit?.outcome).toBe('failure');
    expect((await decide(id, await freshBearer(EMAIL))).status).toBe(400); // 同一請求不能再用
    expect(await codeCount()).toBe(0);
  });

  it('不是剛用密碼登入（還原的舊登入）→ 403 OAUTH_REAUTH_REQUIRED，不產生授權碼；請求保留，重新登入後可再批准', async () => {
    const id = await start();
    const stale = await api.tokenFor(EMAIL);
    const res = await decide(id, stale);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OAUTH_REAUTH_REQUIRED');
    expect(await codeCount()).toBe(0);
    const retry = await decide(id, await freshBearer(EMAIL));
    expect(retry.status).toBe(200);
    expect(await codeCount()).toBe(1);
  });

  it('login code 不是 /api/oauth/login 簽的（有 redirect_uri 的一般授權碼）不算剛登入', async () => {
    const token = await api.tokenFor(EMAIL);
    await new D1Adapter(db, 'AuthorizationCode').upsert(`h2-login-${token}`, {
      client_id: 'http-test', user_id: userIdFor(EMAIL), redirect_uri: 'https://x.com/cb', scopes: [], grantId: `grant-${token}`, consumed: Date.now(),
    }, 60);
    expect((await decide(await start(), token)).status).toBe(403);
  });

  it('意圖只來自 App：web 事後設的意圖端點在重新驗證模式被拒，也不能覆寫', async () => {
    const id = await start();
    const bearer = await freshBearer(EMAIL);
    const set = await api.request('POST', `${BASE}/${id}/intent`, { bearer, json: { intent: 'disable' } });
    expect(set.status).toBe(400);
    const loc = new URL(((await (await decide(id, bearer)).json()) as { redirect_to: string }).redirect_to);
    expect(loc.searchParams.get('biometric_intent')).toBe('enable');
  });

  it('重放同一請求不能二次使用', async () => {
    const id = await start();
    const bearer = await freshBearer(EMAIL);
    expect((await decide(id, bearer)).status).toBe(200);
    expect((await decide(id, bearer)).status).toBe(400);
    expect(await codeCount()).toBe(1);
  });

  it('deny 不受重新驗證限制，也不帶旗標', async () => {
    const id = await start();
    const res = await decide(id, await api.tokenFor(OTHER), 'deny');
    expect(res.status).toBe(200);
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.has('biometric_intent')).toBe(false);
  });
});

describe('一般授權不變', () => {
  it('沒有 prompt=login：帶了 biometric_intent／expected_account 也不檢查帳號與新鮮度、不帶旗標', async () => {
    const id = await start({ biometric_intent: 'enable', expected_account: userIdFor(EMAIL) });
    const res = await decide(id, await api.tokenFor(OTHER));
    expect(res.status).toBe(200);
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect([...loc.searchParams.keys()].sort()).toEqual(['code', 'state']);
  });

});

describe('單獨 prompt=login：強制重新輸入密碼', () => {
  const only = { prompt: 'login' };
  const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('不是剛用密碼登入 → 403 OAUTH_REAUTH_REQUIRED，不發碼；請求保留，重新登入後可再批准', async () => {
    const id = await start(only);
    const res = await decide(id, await api.tokenFor(EMAIL));
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('OAUTH_REAUTH_REQUIRED');
    expect(await codeCount()).toBe(0);
    const retry = await decide(id, await freshBearer(EMAIL));
    expect(retry.status).toBe(200);
    const loc = new URL(((await retry.json()) as { redirect_to: string }).redirect_to);
    expect([...loc.searchParams.keys()].sort()).toEqual(['code', 'state']);
  });

  it('沒有 expected_account：不比對帳號，任何剛登入的帳號都可批准', async () => {
    const res = await decide(await start(only), await freshBearer(OTHER));
    expect(res.status).toBe(200);
    expect(await codeCount()).toBe(1);
  });

  it('deny 不受限制', async () => {
    const res = await decide(await start(only), await api.tokenFor(OTHER), 'deny');
    expect(res.status).toBe(200);
  });

  it('舊的意圖端點照常可用，批准時仍帶旗標', async () => {
    const id = await start(only);
    const bearer = await freshBearer(OTHER);
    expect((await api.request('POST', `${BASE}/${id}/intent`, { bearer, json: { intent: 'enable' } })).status).toBe(204);
    const loc = new URL(((await (await decide(id, bearer)).json()) as { redirect_to: string }).redirect_to);
    expect(loc.searchParams.get('biometric_intent')).toBe('enable');
  });
});
