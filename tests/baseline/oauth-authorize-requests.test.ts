/**
 * /api/oauth/authorize/requests/:id（GET／approve／deny）—— 同意畫面的 JSON 端點。
 * 取代舊的 POST /api/oauth/consent（cookie + form）：Consent 儲存、scope 檢查併入 approve。
 * 重點：單次使用、TTL、redirect_to 只來自已註冊並驗過的 redirect_uri、bearer 使用者。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const CLIENT = 'h1-areq-partner';
const CB = 'https://x.com/cb';
const CB_WITH_QUERY = 'https://x.com/cb2?source=1&code=stale';
const EMAIL = 'h1-areq-user@example.com';
const OTHER_EMAIL = 'h1-areq-other@example.com';
const USER_ID = userIdFor(EMAIL);
const PKCE = { code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256' };
const BASE = '/api/oauth/authorize/requests';

let db: D1Database;
let api: Api;

const consentRows = async () => (await db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'Consent' AND id LIKE 'h1-%' OR (name = 'Consent' AND json_extract(payload, '$.client_id') = ?)").bind(CLIENT).all<{ payload: string; expires_at: number }>()).results;
const codeRows = async () => (await db.prepare("SELECT id, payload FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.client_id') = ?").bind(CLIENT).all<{ id: string; payload: string }>()).results;
const requestExists = async (id: string) => (await db.prepare("SELECT 1 AS x FROM oauth_models WHERE name = 'AuthRequest' AND id = ?").bind(id).first()) !== null;

/** 直接存一筆 AuthRequest（等同 /authorize 通過驗證後的結果）。 */
async function putRequest(over: Record<string, unknown> = {}, ttl = 600): Promise<string> {
  const id = `h1-areq-${crypto.randomUUID()}`;
  await new D1Adapter(db, 'AuthRequest').upsert(id, {
    client_id: CLIENT, redirect_uri: CB, scopes: ['openid', 'profile'], state: 'csrf-1',
    code_challenge: PKCE.code_challenge, code_challenge_method: 'S256', prompt: null, ...over,
  }, ttl);
  return id;
}

const approve = (id: string, as: string | null = EMAIL, extra: Record<string, unknown> = {}) =>
  api.request('POST', `${BASE}/${id}/approve`, { ...(as ? { as } : {}), json: extra });
const deny = (id: string, as: string | null = EMAIL, extra: Record<string, unknown> = {}) =>
  api.request('POST', `${BASE}/${id}/deny`, { ...(as ? { as } : {}), json: extra });

const CLEAN = "DELETE FROM oauth_models WHERE (name = 'AuthRequest' AND id LIKE 'h1-areq-%') OR (name IN ('Consent', 'AuthorizationCode') AND json_extract(payload, '$.client_id') = 'h1-areq-partner')";

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await db.prepare(`INSERT OR REPLACE INTO client_apps
    (client_id, client_type, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, 'public', 'Partner App', ?, ?, 'active')`)
    .bind(CLIENT, JSON.stringify([CB, CB_WITH_QUERY]), JSON.stringify(['openid', 'profile'])).run();
});
beforeEach(async () => { await db.prepare(CLEAN).run(); });
afterAll(async () => {
  await db.prepare(CLEAN).run();
  await db.prepare("DELETE FROM client_apps WHERE client_id LIKE 'h1-areq-%'").run();
  await db.prepare("DELETE FROM auth_audit_log WHERE client_id LIKE 'h1-areq-%'").run();
  await disposeMiniflare();
});

describe('認證', () => {
  it.each([['GET'], ['POST approve'], ['POST deny']])('%s 沒有 bearer → 401，且不動 AuthRequest', async (which) => {
    const id = await putRequest();
    const res = which === 'GET' ? await api.get(`${BASE}/${id}`)
      : await api.request('POST', `${BASE}/${id}/${which.endsWith('deny') ? 'deny' : 'approve'}`);
    expect(res.status).toBe(401);
    expect(await requestExists(id)).toBe(true);
    expect(await codeRows()).toHaveLength(0);
  });

  it('service token（沒有使用者）→ 403，不發 code、不消耗請求', async () => {
    const id = await putRequest();
    const token = `h1-areq-svc-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(token, { jti: token, client_id: 'svc', user_id: null, scopes: ['ops:maps'], grantId: 'g' }, 300);
    const res = await api.request('POST', `${BASE}/${id}/approve`, { bearer: token });
    expect(res.status).toBe(403);
    expect(await requestExists(id)).toBe(true);
    expect(await codeRows()).toHaveLength(0);
  });
});

describe('GET /api/oauth/authorize/requests/:id', () => {
  it('回顯示用資料（client 名稱、scopes、needs_consent），不洩漏 redirect_uri／challenge，也不消耗請求', async () => {
    const id = await putRequest();
    const res = await api.get(`${BASE}/${id}`, { as: EMAIL });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ client: { client_id: CLIENT, app_name: 'Partner App' }, scopes: ['openid', 'profile'], needs_consent: true });
    expect(JSON.stringify(body)).not.toContain(CB);
    expect(JSON.stringify(body)).not.toContain(PKCE.code_challenge);
    expect(await requestExists(id)).toBe(true);
  });

  it('已同意過涵蓋全部 scope → needs_consent=false；prompt=consent 強制重新同意', async () => {
    await new D1Adapter(db, 'Consent').upsert(`${USER_ID}:${CLIENT}`, { user_id: USER_ID, client_id: CLIENT, scopes: ['openid', 'profile'], grantedAt: Date.now() }, 60);
    const id = await putRequest();
    expect(((await (await api.get(`${BASE}/${id}`, { as: EMAIL })).json()) as { needs_consent: boolean }).needs_consent).toBe(false);
    const forced = await putRequest({ prompt: 'consent' });
    expect(((await (await api.get(`${BASE}/${forced}`, { as: EMAIL })).json()) as { needs_consent: boolean }).needs_consent).toBe(true);
  });

  it('已授權但 scope 不足 → needs_consent=true', async () => {
    await new D1Adapter(db, 'Consent').upsert(`${USER_ID}:${CLIENT}`, { user_id: USER_ID, client_id: CLIENT, scopes: ['openid'], grantedAt: Date.now() }, 60);
    const id = await putRequest();
    expect(((await (await api.get(`${BASE}/${id}`, { as: EMAIL })).json()) as { needs_consent: boolean }).needs_consent).toBe(true);
  });

  it('不存在、過期的 id → 400', async () => {
    expect((await api.get(`${BASE}/nope`, { as: EMAIL })).status).toBe(400);
    const expired = await putRequest({}, -1);
    expect((await api.get(`${BASE}/${expired}`, { as: EMAIL })).status).toBe(400);
  });
});

describe('POST approve', () => {
  it('寫入 Consent（驗過的 scopes、TTL 1 年）並發 code，回 { redirect_to }；code 綁使用者／client／redirect_uri／PKCE', async () => {
    const id = await putRequest();
    const res = await approve(id);
    expect(res.status).toBe(200);
    const { redirect_to } = await res.json() as { redirect_to: string };
    const loc = new URL(redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('state')).toBe('csrf-1');
    const code = loc.searchParams.get('code')!;
    const stored = await new D1Adapter(db, 'AuthorizationCode').find(code);
    expect(stored).toMatchObject({ client_id: CLIENT, user_id: USER_ID, redirect_uri: CB, scopes: ['openid', 'profile'], code_challenge: PKCE.code_challenge, code_challenge_method: 'S256' });

    const consent = await new D1Adapter(db, 'Consent').findWithExpiry(`${USER_ID}:${CLIENT}`);
    expect(consent?.payload.scopes).toEqual(['openid', 'profile']);
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(consent!.expiresAt - Date.now()).toBeGreaterThan(year - 60_000);
    expect(consent!.expiresAt - Date.now()).toBeLessThanOrEqual(year);
  });

  it('單次使用：approve 後請求即刪，重放得 400、不再發第二個 code', async () => {
    const id = await putRequest();
    expect((await approve(id)).status).toBe(200);
    expect(await requestExists(id)).toBe(false);
    const replay = await approve(id);
    expect(replay.status).toBe(400);
    expect(await codeRows()).toHaveLength(1);
  });

  it('approve 後也不能再 deny（反向重放）', async () => {
    const id = await putRequest();
    await approve(id);
    expect((await deny(id)).status).toBe(400);
  });

  it('過期的請求 → 400，不寫 Consent、不發 code', async () => {
    const id = await putRequest({}, -1);
    const res = await approve(id);
    expect(res.status).toBe(400);
    expect(await codeRows()).toHaveLength(0);
    expect(await consentRows()).toHaveLength(0);
  });

  it('redirect_to 只用存下來的已註冊 redirect_uri；web 傳來的 redirect_uri／state／URL 一律無效', async () => {
    const id = await putRequest();
    const res = await approve(id, EMAIL, { redirect_uri: 'https://evil.example/steal', redirect_to: 'https://evil.example', state: 'attacker', scope: 'openid profile admin', client_id: 'other' });
    const { redirect_to } = await res.json() as { redirect_to: string };
    const loc = new URL(redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('state')).toBe('csrf-1');
    const stored = await new D1Adapter(db, 'AuthorizationCode').find(loc.searchParams.get('code')!);
    expect(stored?.scopes).toEqual(['openid', 'profile']);
    expect(stored?.client_id).toBe(CLIENT);
  });

  it('保留 redirect_uri 原有的 query，並以新 code 取代舊的 code', async () => {
    const id = await putRequest({ redirect_uri: CB_WITH_QUERY });
    const loc = new URL(((await (await approve(id)).json()) as { redirect_to: string }).redirect_to);
    expect(loc.origin + loc.pathname).toBe('https://x.com/cb2');
    expect(loc.searchParams.get('source')).toBe('1');
    expect(loc.searchParams.get('code')).not.toBe('stale');
    expect(loc.searchParams.getAll('code')).toHaveLength(1);
  });

  it('授權請求建立後 redirect_uri 被取消註冊 → 400，不導向、不發 code、不寫 Consent', async () => {
    const id = await putRequest({ redirect_uri: 'https://x.com/removed' });
    const res = await approve(id);
    expect(res.status).toBe(400);
    expect(await codeRows()).toHaveLength(0);
    expect(await consentRows()).toHaveLength(0);
  });

  it('client 已停用 → 400，不發 code', async () => {
    await db.prepare("UPDATE client_apps SET status = 'suspended' WHERE client_id = ?").bind(CLIENT).run();
    try {
      const id = await putRequest();
      expect((await approve(id)).status).toBe(400);
      expect(await codeRows()).toHaveLength(0);
    } finally {
      await db.prepare("UPDATE client_apps SET status = 'active' WHERE client_id = ?").bind(CLIENT).run();
    }
  });

  it('存下的 scope 超出 client 允許範圍（資料被竄改）→ 400，不寫 Consent', async () => {
    const id = await putRequest({ scopes: ['openid', 'admin'] });
    expect((await approve(id)).status).toBe(400);
    expect(await consentRows()).toHaveLength(0);
    expect(await codeRows()).toHaveLength(0);
  });

  it('存下的 PKCE 缺失（資料被竄改）→ 400，不發 code', async () => {
    const id = await putRequest({ code_challenge: null, code_challenge_method: null });
    expect((await approve(id)).status).toBe(400);
    expect(await codeRows()).toHaveLength(0);
  });

  it('重複同意只留一筆 Consent（覆寫）', async () => {
    await approve(await putRequest());
    await approve(await putRequest({ scopes: ['openid'] }));
    const n = await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'Consent' AND id = ?").bind(`${USER_ID}:${CLIENT}`).first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect((await new D1Adapter(db, 'Consent').find(`${USER_ID}:${CLIENT}`))?.scopes).toEqual(['openid']);
  });

  it('發出的 code 綁的是呼叫者，不是別人', async () => {
    const id = await putRequest();
    const loc = new URL(((await (await approve(id, OTHER_EMAIL)).json()) as { redirect_to: string }).redirect_to);
    expect((await new D1Adapter(db, 'AuthorizationCode').find(loc.searchParams.get('code')!))?.user_id).toBe(userIdFor(OTHER_EMAIL));
  });
});

describe('POST deny', () => {
  it('回帶 error=access_denied 與 state 的 redirect_to；不發 code、不寫 Consent、請求即刪', async () => {
    const id = await putRequest();
    const res = await deny(id);
    expect(res.status).toBe(200);
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('csrf-1');
    expect(loc.searchParams.has('code')).toBe(false);
    expect(await codeRows()).toHaveLength(0);
    expect(await consentRows()).toHaveLength(0);
    expect(await requestExists(id)).toBe(false);
  });

  it('單次使用：deny 後再 deny／approve 都是 400', async () => {
    const id = await putRequest();
    expect((await deny(id)).status).toBe(200);
    expect((await deny(id)).status).toBe(400);
    expect((await approve(id)).status).toBe(400);
    expect(await codeRows()).toHaveLength(0);
  });

  it('web 傳來的 redirect_uri 無效；redirect_to 仍是已註冊的 redirect_uri', async () => {
    const id = await putRequest({ redirect_uri: CB_WITH_QUERY });
    const loc = new URL(((await (await deny(id, EMAIL, { redirect_uri: 'https://evil.example' })).json()) as { redirect_to: string }).redirect_to);
    expect(loc.origin + loc.pathname).toBe('https://x.com/cb2');
    expect(loc.searchParams.get('source')).toBe('1');
    expect(loc.searchParams.has('code')).toBe(false); // 原本 query 裡的 code=stale 也清掉
    expect(loc.searchParams.get('error')).toBe('access_denied');
  });

  it('redirect_uri 已不在註冊清單 → 400（不導向未註冊網址）', async () => {
    const id = await putRequest({ redirect_uri: 'https://attacker.example/cb' });
    const res = await deny(id);
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
    expect(await res.text()).not.toContain('attacker.example');
  });

  it('過期 → 400', async () => {
    expect((await deny(await putRequest({}, -1))).status).toBe(400);
  });
});
