/**
 * GET /api/oauth/authorize —— 第三方 client 的授權入口（OAuth 2.1 authorization code + PKCE）。
 *
 * 設計變更（新 api 沒有 cookie，網頁畫面留在 web）：
 *   1. 驗證請求（client、redirect_uri 精確比對、scope、PKCE）；錯誤處理沿用舊行為：
 *      - 不可導回 client（client／redirect_uri 有問題）→ 400 JSON；
 *      - 可導回 client → 302 redirect_uri?error=...&state=...
 *   2. 通過後存一筆 AuthRequest（oauth_models，id = 隨機 32 bytes、TTL 10 分鐘，內容是驗過的參數），
 *      302 到 `${WEB_ORIGIN}/oauth/authorize?request_id=<id>`（WEB_ORIGIN 缺省用 PUBLIC_ORIGIN；都沒有 → 400）。
 *   3. 登入、同意頁由 web 負責，經 `/api/oauth/authorize/requests/:id`（見 authorize-requests.ts）完成。
 * 網址只帶不透明的 request_id：redirect_uri 等參數都留在 server 端，web 無法竄改。
 * 例外：biometric_hint 為白名單值時一併帶上（登入前就要決定是否顯示專門鈕，此時讀不到需 bearer 的 GET requests/:id；僅顯示用）。
 */
import { buildAuthRequestPayload, createAuthRequest, parseReauth } from '../../../lib/auth-request';
import { loadClientApp, validateAuthorizeRequest, type ClientAppRow } from '../../../lib/oauth-server/validate-authorize-request';
import { PARAM_BIOMETRIC_HINT, PARAM_BIOMETRIC_INTENT, PARAM_REAUTH, REAUTH_LOGIN, isBiometricHint } from '../../../lib/oauth-contract';
import { buildClientRedirect } from '../../../lib/oauth-single-use';
import { oauthErrorResponse } from '../../../errors';
import { MOBILE_GATE_MESSAGE, isMobileClientId, mobileClientAllowed } from '../../../lib/mobile-oauth';
import type { Env } from '../../../env';

/** 網頁端 origin：WEB_ORIGIN 優先，缺省用 PUBLIC_ORIGIN；都沒有則 null。 */
function webOrigin(env: Env): string | null {
  const e = env as Env;
  const raw = e.WEB_ORIGIN || e.PUBLIC_ORIGIN;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const params = new URL(context.request.url).searchParams;
  const req = {
    response_type: params.get('response_type') ?? undefined,
    client_id: params.get('client_id') ?? undefined,
    redirect_uri: params.get('redirect_uri') ?? undefined,
    scope: params.get('scope') ?? undefined,
    state: params.get('state') ?? undefined,
    code_challenge: params.get('code_challenge') ?? undefined,
    code_challenge_method: params.get('code_challenge_method') ?? undefined,
    prompt: params.get('prompt') ?? undefined,
  };

  // mobile client 的環境閘門（自舊入口移植）：client 與 redirect_uri 必須與環境契約精確相符，否則不可導回 client → 400
  if (isMobileClientId(req.client_id ?? '') && !mobileClientAllowed(context.env, context.request, req.client_id!, req.redirect_uri ?? null)) {
    return oauthErrorResponse('unauthorized_client', MOBILE_GATE_MESSAGE, 400);
  }

  const client: ClientAppRow | null = req.client_id ? await loadClientApp(context.env.DB, req.client_id) : null;

  const result = validateAuthorizeRequest(req, client);
  if ('code' in result && 'redirectableToClient' in result) {
    if (result.redirectableToClient && req.redirect_uri) {
      // validate 通過 redirect_uri 精確比對後才會是 redirectable，所以這裡不會導向未註冊的網址
      return new Response(null, {
        status: 302,
        headers: { Location: buildClientRedirect(req.redirect_uri, { error: result.code, errorDescription: result.message, state: req.state ?? null }) },
      });
    }
    return oauthErrorResponse(result.code, result.message, 400);
  }

  const origin = webOrigin(context.env);
  if (!origin) {
    return oauthErrorResponse('server_error', 'WEB_ORIGIN／PUBLIC_ORIGIN 未設定，無法導向授權畫面', 400);
  }

  // 重新驗證：只有 prompt=login 且 biometric_intent 為白名單值才成立，此時 expected_account 必須合法（否則 fail-closed，不建請求）
  const reauth = parseReauth(result.prompt, params.get(PARAM_BIOMETRIC_INTENT), params.get('expected_account'));
  if (reauth.kind === 'invalid_account') {
    return new Response(null, {
      status: 302,
      headers: { Location: buildClientRedirect(result.redirectUri, { error: 'invalid_request', errorDescription: 'expected_account 缺少或格式不正確', state: result.state }) },
    });
  }

  const hintParam = params.get(PARAM_BIOMETRIC_HINT) ?? '';
  const biometricHint = isBiometricHint(hintParam) ? hintParam : null;
  const requestId = await createAuthRequest(context.env.DB, buildAuthRequestPayload(result, {
    biometricHint,
    reauth: reauth.kind === 'reauth' ? reauth : null,
  }));

  const location = new URL('/oauth/authorize', origin);
  location.searchParams.set('request_id', requestId);
  if (biometricHint) location.searchParams.set(PARAM_BIOMETRIC_HINT, biometricHint);
  // 單獨 prompt=login 也要 web 強制顯示登入表單：reauth=login（值只來自 REAUTH_MODES 白名單）
  const reauthParam = (reauth.kind === 'reauth' ? reauth.intent : null) ?? (result.prompt === 'login' ? REAUTH_LOGIN : null);
  if (reauthParam) location.searchParams.set(PARAM_REAUTH, reauthParam);
  return new Response(null, { status: 302, headers: { Location: location.toString() } });
};
