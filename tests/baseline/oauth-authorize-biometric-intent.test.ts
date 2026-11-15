/**
 * 授權請求的「來自 App」資訊、生物辨識意圖與導回旗標（ADR-0018）。
 * 重點：導回網址一律由 server 用已驗過的 redirect_uri 組；web 傳什麼都不能影響；意圖只對設定它的使用者有效。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import type { Env } from '../../src/env';

const CLIENT = 'h1-bio-partner';
const CB = 'https://x.com/cb';
const CB_FLAGGED = 'https://x.com/cb-flagged?biometric_intent=enable&source=1';
const WEB = 'https://web.example';
const EMAIL = 'h1-bio-user@example.com';
const OTHER = 'h1-bio-other@example.com';
const PKCE = { code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256' };
const BASE = '/api/oauth/authorize/requests';
const VALID = { client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid', state: 'st-1', ...PKCE };

let db: D1Database;
let api: Api;

const CLEAN = "DELETE FROM oauth_models WHERE (name = 'AuthRequest' AND json_extract(payload, '$.client_id') = 'h1-bio-partner') OR (name IN ('Consent', 'AuthorizationCode') AND json_extract(payload, '$.client_id') = 'h1-bio-partner')";

/** 走真正的 /authorize 建立授權請求，回傳 request_id。 */
async function start(params: Record<string, string> = {}): Promise<string> {
  const res = await api.get(`https://x.com/api/oauth/authorize?${new URLSearchParams({ ...VALID, ...params })}`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('Location')!).searchParams.get('request_id')!;
}
const info = async (id: string, as = EMAIL) => (await api.request('GET', `${BASE}/${id}`, { as })).json() as Promise<Record<string, unknown>>;
const setIntent = (id: string, intent: unknown, as: string | null = EMAIL) =>
  api.request('POST', `${BASE}/${id}/intent`, { ...(as ? { as } : {}), json: { intent } });
async function approve(id: string, as = EMAIL, extra: Record<string, unknown> = {}, path = '') {
  const res = await api.request('POST', `${BASE}/${id}/approve${path}`, { as, json: extra });
  expect(res.status).toBe(200);
  return new URL(((await res.json()) as { redirect_to: string }).redirect_to);
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { WEB_ORIGIN: WEB } as Partial<Env>) });
  await db.prepare(`INSERT OR REPLACE INTO client_apps
    (client_id, client_type, app_name, redirect_uris, allowed_scopes, status)
    VALUES (?, 'public', 'Partner App', ?, ?, 'active')`)
    .bind(CLIENT, JSON.stringify([CB, CB_FLAGGED]), JSON.stringify(['openid'])).run();
});
beforeEach(async () => { await db.prepare(CLEAN).run(); });
afterAll(async () => {
  await db.prepare(CLEAN).run();
  await db.prepare("DELETE FROM client_apps WHERE client_id = 'h1-bio-partner'").run();
  await db.prepare("DELETE FROM auth_audit_log WHERE client_id = 'h1-bio-partner'").run();
  await disposeMiniflare();
});

describe('GET requests/:id 的來源與名稱提示', () => {
  it.each([
    ['faceid', true, 'faceid'],
    ['touchid', true, 'touchid'],
    ['generic', true, null],
  ])('biometric_hint=%s → from_app=%s、hint=%s', async (hint, fromApp, name) => {
    const body = await info(await start({ biometric_hint: hint }));
    expect(body.from_app).toBe(fromApp);
    expect(body.biometric_hint).toBe(name);
  });

  it.each([[{}], [{ biometric_hint: 'retina' }], [{ biometric_hint: '' }]])('舊版 App／未知值 %j → 當作沒帶', async (params) => {
    const body = await info(await start(params));
    expect(body.from_app).toBe(false);
    expect(body.biometric_hint).toBeNull();
  });
});

describe('意圖端點', () => {
  it('沒有 bearer 401；service token 403；不存在的請求 400；非法值 400，且都不影響請求', async () => {
    const id = await start({ biometric_hint: 'faceid' });
    expect((await setIntent(id, 'enable', null)).status).toBe(401);
    const token = `h1-bio-svc-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(token, { jti: token, client_id: 'svc', user_id: null, scopes: ['ops:maps'], grantId: 'g' }, 300);
    expect((await api.request('POST', `${BASE}/${id}/intent`, { bearer: token, json: { intent: 'enable' } })).status).toBe(403);
    expect((await setIntent('h1-bio-nope', 'enable')).status).toBe(400);
    expect((await setIntent(id, 'delete-everything')).status).toBe(400);
    expect((await api.request('POST', `${BASE}/${id}/intent`, { as: EMAIL })).status).toBe(400); // 沒有 body
    expect((await approve(id)).searchParams.has('biometric_intent')).toBe(false);
  });

  it('不存在或已使用的請求不能被意圖「復活」', async () => {
    const id = await start();
    await approve(id);
    expect((await setIntent(id, 'enable')).status).toBe(400);
    const exists = await db.prepare("SELECT 1 AS x FROM oauth_models WHERE name = 'AuthRequest' AND id = ?").bind(id).first();
    expect(exists).toBeNull();
  });
});

describe('approve 的導回網址', () => {
  it.each(['enable', 'disable'])('意圖 %s → redirect_to 多旗標，code／state 照舊', async (intent) => {
    const id = await start({ biometric_hint: 'faceid' });
    expect((await setIntent(id, intent)).status).toBe(204);
    const loc = await approve(id);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get('biometric_intent')).toBe(intent);
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('st-1');
  });

  it('沒有意圖 → 與現在完全相同（只有 code 與 state）；設了又清掉也一樣', async () => {
    const plain = await approve(await start());
    expect([...plain.searchParams.keys()].sort()).toEqual(['code', 'state']);
    const id = await start({ biometric_hint: 'faceid' });
    await setIntent(id, 'enable');
    expect((await setIntent(id, null)).status).toBe(204);
    expect([...(await approve(id)).searchParams.keys()].sort()).toEqual(['code', 'state']);
  });

  it('舊版 App（不帶 biometric_hint）也能設意圖與批准，流程不變', async () => {
    const id = await start();
    await setIntent(id, 'enable');
    expect((await approve(id)).searchParams.get('biometric_intent')).toBe('enable');
  });

  it('web 傳的 URL／參數／旗標一律無效（body、query、路徑都試）', async () => {
    const id = await start();
    const res = await api.request('POST', `${BASE}/${id}/approve?biometric_intent=enable&redirect_to=https://evil.test&redirect_uri=https://evil.test`, {
      as: EMAIL,
      json: { redirect_to: 'https://evil.test/x', redirect_uri: 'https://evil.test', biometric_intent: 'enable', intent: 'enable', state: 'forged' },
    });
    expect(res.status).toBe(200);
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect([...loc.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(loc.searchParams.get('state')).toBe('st-1');
  });

  it('意圖欄位只收白名單：存進去的奇怪值不會原樣出現在網址（直接寫入 payload 也一樣）', async () => {
    const id = await start();
    await db.prepare("UPDATE oauth_models SET payload = json_set(payload, '$.intent', ?, '$.intent_user_id', ?) WHERE name = 'AuthRequest' AND id = ?")
      .bind('https://evil.test&x=1', userIdFor(EMAIL), id).run();
    expect((await approve(id)).searchParams.has('biometric_intent')).toBe(false);
  });

  it('已註冊的 redirect_uri 自帶同名參數 → 沒有意圖時被清掉，有意圖時以 server 為準', async () => {
    const none = await approve(await start({ redirect_uri: CB_FLAGGED }));
    expect(none.searchParams.has('biometric_intent')).toBe(false);
    expect(none.searchParams.get('source')).toBe('1');
    const id = await start({ redirect_uri: CB_FLAGGED });
    await setIntent(id, 'disable');
    expect((await approve(id)).searchParams.getAll('biometric_intent')).toEqual(['disable']);
  });

  it('意圖只對設定它的使用者有效：別人批准不帶旗標；別人改設也不會讓原使用者拿到旗標', async () => {
    const id = await start();
    await setIntent(id, 'enable', EMAIL);
    expect((await approve(id, OTHER)).searchParams.has('biometric_intent')).toBe(false);

    const id2 = await start();
    await setIntent(id2, 'enable', EMAIL);
    await setIntent(id2, 'disable', OTHER); // 後設者蓋過，且綁定到後設者
    expect((await approve(id2, EMAIL)).searchParams.has('biometric_intent')).toBe(false);
  });

  it('deny 不帶旗標', async () => {
    const id = await start();
    await setIntent(id, 'enable');
    const res = await api.request('POST', `${BASE}/${id}/deny`, { as: EMAIL });
    const loc = new URL(((await res.json()) as { redirect_to: string }).redirect_to);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.has('biometric_intent')).toBe(false);
  });
});
