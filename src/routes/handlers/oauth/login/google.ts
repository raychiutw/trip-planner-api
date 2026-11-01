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
 */
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { validateAuthorizeRequest, type ClientAppRow } from '../../../../lib/oauth-server/validate-authorize-request';
import { buildClientRedirect } from '../../../../lib/oauth-single-use';
import { generateOpaqueToken, getPublicOrigin } from '../../../../lib/utils';
import { sha256Base64Url } from '../../../../lib/crypto';
import { parseAllowedScopes } from '../../../../lib/oauth-request';
import { oauthErrorResponse } from '../../../../errors';
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

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const googleClientId = context.env.GOOGLE_CLIENT_ID;
  if (!googleClientId || !context.env.GOOGLE_CLIENT_SECRET) {
    return notConfigured('Google 登入尚未設定（GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET）');
  }

  const params = new URL(context.request.url).searchParams;
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
