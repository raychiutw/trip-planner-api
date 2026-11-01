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
 */
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { validateAuthorizeRequest, type ClientAppRow } from '../../../lib/oauth-server/validate-authorize-request';
import { buildClientRedirect } from '../../../lib/oauth-single-use';
import { generateOpaqueToken } from '../../../lib/utils';
import { oauthErrorResponse } from '../../../errors';
import type { Env } from '../../../env';

export const AUTH_REQUEST_TTL_SEC = 10 * 60;

/** AuthRequest 的內容：驗過的參數（consent 與 code 都只信這份，不信 web 傳入的值）。 */
export interface AuthRequestPayload {
  [key: string]: unknown;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: 'S256' | null;
  prompt: string | null;
}

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

  let client: ClientAppRow | null = null;
  if (req.client_id) {
    client = await context.env.DB
      .prepare('SELECT client_id, client_type, app_name, redirect_uris, allowed_scopes, status FROM client_apps WHERE client_id = ?')
      .bind(req.client_id)
      .first<ClientAppRow>();
  }

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

  const requestId = generateOpaqueToken(32);
  const payload: AuthRequestPayload = {
    client_id: result.client.client_id,
    redirect_uri: result.redirectUri,
    scopes: result.scopes,
    state: result.state,
    code_challenge: result.codeChallenge,
    code_challenge_method: result.codeChallengeMethod,
    prompt: result.prompt,
  };
  await new D1Adapter(context.env.DB, 'AuthRequest').upsert(requestId, payload, AUTH_REQUEST_TTL_SEC);

  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}/oauth/authorize?request_id=${encodeURIComponent(requestId)}` },
  });
};
