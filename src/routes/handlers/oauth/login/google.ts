/**
 * GET /api/oauth/login/google —— 以 Google 登入，換取我們自己的 authorization code。
 *
 * 設計變更（沒有 cookie）：Google 登入必須經瀏覽器跳轉，所以 state、nonce 與對 Google 的 PKCE
 * 都存在 oauth_models（name='GoogleLoginState'、TTL 10 分鐘、單次使用），不用 cookie。
 *
 * Query：client_id、redirect_uri、code_challenge（S256，必填）、state?、scope?、dpop_jkt?
 *   - client／redirect_uri／scope／PKCE 一律走 validateAuthorizeRequest（redirect_uri 精確比對）；
 *     錯誤處理同 /authorize：不可導回 client → 400 JSON；可導回 → 302 error。
 *   - 沒有 GOOGLE_CLIENT_ID → 503 OAUTH_NOT_CONFIGURED（明確的設定錯誤）。
 * 完成後由 callback/google 302 回 client 註冊的 redirect_uri 並帶我們的 code。
 *
 * 帳號刪除重新驗證分支（`?purpose=account-delete&challenge=<id>`，自舊入口移植，wire 不變）：
 *   公開入口（challenge id 就是不可猜的憑證，由 POST /api/account/delete-reauth 發出）。
 *   challenge 必須存在、未過期、client 與環境相符、狀態為 pending 或 started，否則 403 ACCOUNT_DELETE_REAUTH_REQUIRED
 *   （JSON）。pending 轉 started；started 允許再開（授權連結被重新整理或預讀時不會卡死）。
 *   web surface（challenge.surface='web'，clientId 必須是 tripline-web）：challenge 存在但已取消／過期／用過 → 302 導回固定的
 *   `${WEB_ORIGIN}/account?deleteReauth=failed`（狀態不動）；找不到 challenge 仍是 403 JSON。
 *   沒帶 challenge 也是 403（舊入口的「瀏覽器 cookie proof」流程在新 api 不存在）。
 *   對 Google 帶 prompt=select_account、max_age=0、claims.auth_time essential；state（5 分鐘）寫失敗時，
 *   只有「本次請求自己轉成 started」才還原為 pending，不降級別人進行中的流程。
 */
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { validateAuthorizeRequest, type ClientAppRow } from '../../../../lib/oauth-server/validate-authorize-request';
import { buildClientRedirect } from '../../../../lib/oauth-single-use';
import { generateOpaqueToken, getPublicOrigin } from '../../../../lib/utils';
import { sha256Base64Url } from '../../../../lib/crypto';
import { parseAllowedScopes } from '../../../../lib/oauth-request';
import { oauthErrorResponse } from '../../../../errors';
import { mobileOAuthContract } from '../../../../lib/mobile-oauth';
import {
  DELETE_PROOF_TTL_MS, WEB_CLIENT_ID, mobileCallbackUrl, readMobileDeleteChallenge, transitionMobileDeleteChallenge, webReauthRedirect,
} from '../../../../lib/delete-reauth';
import type { Env } from '../../../../env';

export const GOOGLE_STATE_TTL_SEC = 10 * 60;
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const allowedScopes = (c: ClientAppRow) => parseAllowedScopes(c.allowed_scopes);
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

export const notConfigured = (message: string) =>
  new Response(JSON.stringify({ error: { code: 'OAUTH_NOT_CONFIGURED', message } }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const reauthRefused = () => new Response(
  JSON.stringify({ error: { code: 'ACCOUNT_DELETE_REAUTH_REQUIRED', message: '請重新驗證身分後再刪除帳號' } }),
  { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
);

/** 帳號刪除的 Google 重新驗證：開始（見檔頭）。 */
async function startDeleteReauth(context: Parameters<PagesFunction<Env>>[0], googleClientId: string, params: URLSearchParams): Promise<Response> {
  const challengeId = params.get('challenge');
  if (!challengeId) return reauthRefused();
  const db = context.env.DB;
  const challenge = await readMobileDeleteChallenge(db, challengeId);
  if (!challenge) return reauthRefused();
  const web = challenge.surface === 'web';
  let redirectUri: string;
  if (web) {
    if (challenge.clientId !== WEB_CLIENT_ID) return reauthRefused();
    const failedRedirect = webReauthRedirect(context.env, 'failed');
    // web 的瀏覽器導覽：已取消、過期、用過等一律導回固定的失敗網址（狀態不動）
    if (challenge.expired || (challenge.status !== 'pending' && challenge.status !== 'started')) {
      return new Response(null, { status: 302, headers: { Location: failedRedirect, 'cache-control': 'no-store' } });
    }
    redirectUri = webReauthRedirect(context.env, 'done');
  } else {
    const contract = mobileOAuthContract(context.env, context.request);
    if (!contract || challenge.expired || challenge.clientId !== contract.clientId ||
        (challenge.status !== 'pending' && challenge.status !== 'started')) {
      return reauthRefused();
    }
    redirectUri = mobileCallbackUrl(context.env).toString();
  }
  let startedByThisRequest = false;
  if (challenge.status === 'pending') {
    if (await transitionMobileDeleteChallenge(db, challengeId, challenge.uid, challenge.grantId, 'pending', 'started')) {
      startedByThisRequest = true;
    } else if ((await readMobileDeleteChallenge(db, challengeId))?.status !== 'started') {
      return reauthRefused(); // 並行的另一個請求把它轉成 started 是可以的；其他狀態（verified／cancelled…）不行
    }
  }

  const googleState = generateOpaqueToken(32);
  const nonce = generateOpaqueToken(32);
  const googleVerifier = generateOpaqueToken(32);
  try {
    await new D1Adapter(db, 'GoogleLoginState').upsert(googleState, {
      provider: 'google',
      client_id: challenge.clientId,
      redirect_uri: redirectUri,
      scopes: [],
      client_state: null,
      nonce,
      google_code_verifier: googleVerifier,
      first_party: false,
      created_at: Date.now(),
      reauth: { uid: challenge.uid, challengeId, grantId: challenge.grantId, clientId: challenge.clientId, surface: challenge.surface },
    }, DELETE_PROOF_TTL_MS / 1000);
  } catch (err) {
    // challenge 已轉為 started 但 state 沒寫成功：還原，否則使用者只能等它過期
    if (startedByThisRequest) await transitionMobileDeleteChallenge(db, challengeId, challenge.uid, challenge.grantId, 'started', 'pending').catch(() => {});
    throw err;
  }

  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: googleClientId,
    redirect_uri: `${getPublicOrigin(context.env, context.request)}/api/oauth/callback/google`,
    scope: 'openid profile email',
    state: googleState,
    nonce,
    code_challenge: await sha256Base64Url(googleVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    max_age: '0',
    claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }),
  })) authorizeUrl.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: authorizeUrl.toString(), 'cache-control': 'no-store' } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const googleClientId = context.env.GOOGLE_CLIENT_ID;
  if (!googleClientId || !context.env.GOOGLE_CLIENT_SECRET) {
    return notConfigured('Google 登入尚未設定（GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET）');
  }

  const params = new URL(context.request.url).searchParams;
  if (params.get('purpose') === 'account-delete') return startDeleteReauth(context, googleClientId, params);
  const clientId = params.get('client_id') ?? undefined;
  const client = clientId
    ? await context.env.DB
        .prepare('SELECT client_id, client_type, app_name, redirect_uris, allowed_scopes, status FROM client_apps WHERE client_id = ?')
        .bind(clientId).first<ClientAppRow>()
    : null;

  const redirectUri = params.get('redirect_uri') ?? undefined;
  const state = params.get('state') ?? undefined;
  const result = validateAuthorizeRequest({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: params.get('scope') ?? (client ? DEFAULT_SCOPES.filter((s) => allowedScopes(client).includes(s)).join(' ') : undefined),
    state,
    code_challenge: params.get('code_challenge') ?? undefined,
    code_challenge_method: params.get('code_challenge_method') ?? undefined,
  }, client);
  if ('code' in result && 'redirectableToClient' in result) {
    if (result.redirectableToClient && redirectUri) {
      return new Response(null, {
        status: 302,
        headers: { Location: buildClientRedirect(redirectUri, { error: result.code, errorDescription: result.message, state: state ?? null }) },
      });
    }
    return oauthErrorResponse(result.code, result.message, 400);
  }

  const dpopJkt = params.get('dpop_jkt');
  if (dpopJkt !== null && !B64URL_43.test(dpopJkt)) {
    return oauthErrorResponse('invalid_request', 'dpop_jkt 格式不正確', 400);
  }

  // 第一方 client（first_party=1 的 public client）的 code 沿用 login.ts 的形狀：不帶 redirect_uri、可綁 dpop_jkt
  const firstParty = await context.env.DB
    .prepare('SELECT first_party FROM client_apps WHERE client_id = ?').bind(result.client.client_id).first<{ first_party: number }>();
  const isFirstParty = firstParty?.first_party === 1 && result.client.client_type === 'public';

  const googleState = generateOpaqueToken(32);
  const nonce = generateOpaqueToken(32);
  const googleVerifier = generateOpaqueToken(32); // 43 字元 base64url
  await new D1Adapter(context.env.DB, 'GoogleLoginState').upsert(googleState, {
    provider: 'google',
    client_id: result.client.client_id,
    redirect_uri: result.redirectUri,
    scopes: result.scopes,
    client_state: result.state,
    code_challenge: result.codeChallenge,
    code_challenge_method: result.codeChallengeMethod,
    nonce,
    google_code_verifier: googleVerifier,
    first_party: isFirstParty,
    ...(dpopJkt ? { dpop_jkt: dpopJkt } : {}),
  }, GOOGLE_STATE_TTL_SEC);

  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: googleClientId,
    redirect_uri: `${getPublicOrigin(context.env, context.request)}/api/oauth/callback/google`,
    scope: 'openid profile email',
    state: googleState,
    nonce,
    code_challenge: await sha256Base64Url(googleVerifier),
    code_challenge_method: 'S256',
  })) authorizeUrl.searchParams.set(k, v);

  return new Response(null, { status: 302, headers: { Location: authorizeUrl.toString(), 'cache-control': 'no-store' } });
};
