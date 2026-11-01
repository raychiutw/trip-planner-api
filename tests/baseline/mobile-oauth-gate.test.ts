// @vitest-environment node
/**
 * mobile OAuth 的環境閘門與 PKCE 往返 —— 走 HTTP 邊界。
 * 自舊入口 PR #1458 的 tests/api/mobile-oauth-callback.test.ts 移植：
 * tripline-mobile／-uat／-dev 只能在對應環境、用精確的 callback 走 authorize／approve／token。
 *
 * 與舊測試的差異（新 api 的授權流程不同）：
 *  - 舊的 authorize 在有 session 時直接導向 consent 頁；新 api 的 authorize 存 AuthRequest 並 302 到 web 的同意頁，
 *    由 `POST /api/oauth/authorize/requests/:id/approve`（bearer）取代 `POST /consent`（cookie＋form），所以閘門也加在 approve。
 *  - UAT 環境的 origin 由明確設定的 PUBLIC_ORIGIN 決定（不再寫死舊 UAT 網域）。
 *  - 閘門的錯誤碼與舊入口一致：authorize／approve → 400 unauthorized_client；token → 400 invalid_client。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { MOBILE_PROD_REDIRECT, MOBILE_UAT_REDIRECT, MOBILE_DEV_REDIRECT } from '../../src/lib/mobile-oauth';
import type { Env } from '../../src/env';

const PROD = 'https://api.prod.test';
const STG = 'https://api.stg.test';
const DEV = 'http://localhost:8788';
const USER = 'mobile-gate-user@example.com';
const USER_ID = userIdFor(USER);

let db: D1Database;
beforeAll(async () => { db = await createTestDb(); }, 30000);
afterAll(async () => {
  await db.prepare("DELETE FROM oauth_models WHERE json_extract(payload, '$.user_id') = ? OR id LIKE 'mg-%'").bind(USER_ID).run();
  await db.prepare("DELETE FROM auth_audit_log WHERE user_id = ?").bind(USER_ID).run();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(USER_ID).run();
  await disposeMiniflare();
});

const apiFor = (overrides: Partial<Env>) => createApi({ env: mockEnv(db, overrides) });
const prodApi = () => apiFor({ ENVIRONMENT: 'production', PUBLIC_ORIGIN: PROD });
const stgApi = () => apiFor({ ENVIRONMENT: 'preview', PUBLIC_ORIGIN: STG });
const devApi = () => apiFor({ ENVIRONMENT: 'development', WEB_ORIGIN: 'http://localhost:5173' });

function authUrl(origin: string, clientId: string, redirectUri: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId,
    redirect_uri: redirectUri, scope: 'openid profile', state: 'mobile-state',
    code_challenge: 'challenge-'.repeat(5), code_challenge_method: 'S256', ...extra });
  return `${origin}/api/oauth/authorize?${params}`;
}
const errorOf = async (res: Response) => (await res.json()) as { error: string };

describe('authorize：環境閘門', () => {
  it('production 只放行 tripline-mobile 與 production callback（302 到 web 同意頁）', async () => {
    const api = prodApi();
    const valid = await api.get(authUrl(PROD, 'tripline-mobile', MOBILE_PROD_REDIRECT));
    expect(valid.status).toBe(302);
    expect(valid.headers.get('Location')).toMatch(new RegExp(`^${PROD}/oauth/authorize\\?request_id=`));
    const cases: Array<[string, string]> = [
      ['tripline-mobile', MOBILE_DEV_REDIRECT],
      ['tripline-mobile', MOBILE_UAT_REDIRECT],
      ['tripline-mobile-uat', MOBILE_UAT_REDIRECT],
      ['tripline-mobile-dev', MOBILE_DEV_REDIRECT],
    ];
    for (const [clientId, redirectUri] of cases) {
      const denied = await api.get(authUrl(PROD, clientId, redirectUri));
      expect(denied.status, `${clientId} ${redirectUri}`).toBe(400);
      expect(denied.headers.get('Location')).toBeNull();
      expect(await errorOf(denied)).toMatchObject({ error: 'unauthorized_client' });
    }
  });

  it('UAT（preview）只放行 tripline-mobile-uat，且請求 origin 必須是設定的 PUBLIC_ORIGIN', async () => {
    const api = stgApi();
    const valid = await api.get(authUrl(STG, 'tripline-mobile-uat', MOBILE_UAT_REDIRECT));
    expect(valid.status).toBe(302);
    expect(valid.headers.get('Location')).toMatch(/\/oauth\/authorize\?request_id=/);
    const otherHost = await api.get(authUrl('https://random-preview.stg.test', 'tripline-mobile-uat', MOBILE_UAT_REDIRECT));
    expect(otherHost.status).toBe(400);
    expect(await errorOf(otherHost)).toMatchObject({ error: 'unauthorized_client' });
    expect((await api.get(authUrl(STG, 'tripline-mobile', MOBILE_PROD_REDIRECT))).status, 'preview 不認 production client').toBe(400);
  });

  it('沒設 PUBLIC_ORIGIN 的 preview 一律拒絕；development 只認 localhost／127.0.0.1 與 dev client', async () => {
    const noOrigin = apiFor({ ENVIRONMENT: 'preview' });
    expect((await noOrigin.get(authUrl(STG, 'tripline-mobile-uat', MOBILE_UAT_REDIRECT))).status).toBe(400);
    const dev = devApi();
    expect((await dev.get(authUrl(DEV, 'tripline-mobile-dev', MOBILE_DEV_REDIRECT))).status).toBe(302);
    expect((await dev.get(authUrl(DEV, 'tripline-mobile', MOBILE_PROD_REDIRECT))).status).toBe(400);
    expect((await dev.get(authUrl('http://evil.example', 'tripline-mobile-dev', MOBILE_DEV_REDIRECT))).status).toBe(400);
    const unset = apiFor({ WEB_ORIGIN: 'https://web.example' }); // 沒有 ENVIRONMENT：不跨環境 fallback
    expect((await unset.get(authUrl(DEV, 'tripline-mobile-dev', MOBILE_DEV_REDIRECT))).status).toBe(400);
  });

  it('client 與 redirect_uri 必須成對：同一環境內 client 搭別人的 callback 被拒', async () => {
    const res = await stgApi().get(authUrl(STG, 'tripline-mobile-uat', 'https://operator.example/cb'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('非 mobile client 不受閘門影響（仍走一般驗證）', async () => {
    const res = await prodApi().get(authUrl(PROD, 'tripline-web', 'https://nowhere.example/cb'));
    expect(res.status).toBe(400); // tripline-web 沒有註冊 redirect_uri：一般驗證的 400，不是閘門
    expect((await errorOf(res)).error).not.toBe('unauthorized_client');
  });
});

describe('approve：環境閘門（取代舊 consent）', () => {
  async function putRequest(clientId: string, redirectUri: string): Promise<string> {
    const id = `mg-areq-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AuthRequest').upsert(id, {
      client_id: clientId, redirect_uri: redirectUri, scopes: ['openid', 'profile'], state: 's',
      code_challenge: 'challenge-'.repeat(5), code_challenge_method: 'S256', prompt: null,
    }, 600);
    return id;
  }
  const approve = (api: ReturnType<typeof apiFor>, origin: string, id: string, decision = 'approve') =>
    api.request('POST', `${origin}/api/oauth/authorize/requests/${id}/${decision}`, { as: USER, json: {} });

  it('在別的環境建立的 request（UAT client）拿到 production 來同意 → 400 unauthorized_client，不發 code', async () => {
    const id = await putRequest('tripline-mobile-uat', MOBILE_UAT_REDIRECT);
    const res = await approve(prodApi(), PROD, id);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ error: 'unauthorized_client' });
    const n = await db.prepare("SELECT count(*) AS n FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.client_id') = 'tripline-mobile-uat'").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('deny 也走同一道閘門；環境相符則正常放行', async () => {
    const wrong = await putRequest('tripline-mobile', MOBILE_PROD_REDIRECT);
    expect((await approve(stgApi(), STG, wrong, 'deny')).status).toBe(400);
    const ok = await putRequest('tripline-mobile', MOBILE_PROD_REDIRECT);
    const res = await approve(prodApi(), PROD, ok);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redirect_to: string }).redirect_to).toMatch(new RegExp(`^${MOBILE_PROD_REDIRECT}\\?code=`));
  });
});

describe('token：環境閘門', () => {
  it('production 的 token endpoint 拒絕 UAT／dev client（任何 grant）→ 400 invalid_client', async () => {
    const api = prodApi();
    for (const clientId of ['tripline-mobile-uat', 'tripline-mobile-dev']) {
      const res = await api.request('POST', `${PROD}/api/oauth/token`, {
        form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: 'unknown' },
      });
      expect(res.status, clientId).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_client' });
    }
  });

  it('preview 拒絕 production client；反之 production 拒絕 UAT（含 authorization_code）', async () => {
    const res = await stgApi().request('POST', `${STG}/api/oauth/token`, {
      form: { grant_type: 'authorization_code', client_id: 'tripline-mobile', redirect_uri: MOBILE_PROD_REDIRECT, code: 'x', code_verifier: 'v'.repeat(43) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('authorization_code 的 redirect_uri 必須是該環境的精確 callback（client 與 redirect_uri 綁定）→ 400 invalid_client', async () => {
    const res = await prodApi().request('POST', `${PROD}/api/oauth/token`, {
      form: { grant_type: 'authorization_code', client_id: 'tripline-mobile', redirect_uri: MOBILE_DEV_REDIRECT, code: 'x', code_verifier: 'v'.repeat(43) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('非 mobile client 不受閘門影響', async () => {
    const res = await prodApi().request('POST', `${PROD}/api/oauth/token`, {
      form: { grant_type: 'refresh_token', client_id: 'tripline-web', refresh_token: 'unknown' },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; error_description?: string };
    expect(body.error_description ?? '', '一般 client 的錯誤不是 mobile 閘門的訊息').not.toMatch(/Mobile client/);
  });
});

describe('UAT public client 的 PKCE code-to-token 往返', () => {
  async function pkce(verifier: string) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function issueCode(verifier: string): Promise<string> {
    const api = stgApi();
    const challenge = await pkce(verifier);
    const start = await api.get(authUrl(STG, 'tripline-mobile-uat', MOBILE_UAT_REDIRECT, { scope: 'profile', state: 'state-preserved', code_challenge: challenge }));
    expect(start.status).toBe(302);
    const requestId = new URL(start.headers.get('Location')!).searchParams.get('request_id')!;
    const approved = await api.request('POST', `${STG}/api/oauth/authorize/requests/${requestId}/approve`, { as: USER, json: {} });
    expect(approved.status).toBe(200);
    const callback = new URL(((await approved.json()) as { redirect_to: string }).redirect_to);
    expect(callback.origin + callback.pathname).toBe(MOBILE_UAT_REDIRECT);
    expect(callback.searchParams.get('state')).toBe('state-preserved');
    return callback.searchParams.get('code')!;
  }
  const exchange = (code: string, codeVerifier: string, redirectUri = MOBILE_UAT_REDIRECT, api = stgApi(), origin = STG) =>
    api.request('POST', `${origin}/api/oauth/token`, {
      form: { grant_type: 'authorization_code', client_id: 'tripline-mobile-uat', redirect_uri: redirectUri, code, code_verifier: codeVerifier },
    });

  it('精確 redirect＋PKCE：錯的 verifier 被拒；對的換到 token；同一個 code 重放被拒', async () => {
    const verifier = 'mobile-pkce-verifier-'.repeat(3);
    const code = await issueCode(verifier);
    const wrong = await exchange(code, 'wrong-verifier-'.repeat(4));
    expect(wrong.status).toBe(400);
    const success = await exchange(code, verifier);
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ token_type: 'Bearer', scope: 'profile' });
    const replay = await exchange(code, verifier);
    expect(replay.status).toBe(400);
  });

  it('跨環境：在 UAT 發的 code 拿到 production 換 token → 400 invalid_client（不是 invalid_grant 之外的放行）', async () => {
    const verifier = 'mobile-pkce-cross-env-'.repeat(3);
    const code = await issueCode(verifier);
    const res = await exchange(code, verifier, MOBILE_UAT_REDIRECT, prodApi(), PROD);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
    expect((await exchange(code, verifier)).status, '被閘門擋下不得消耗 code').toBe(200);
  });
});
