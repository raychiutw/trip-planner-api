import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import {
  OauthMisc_AuthRequestInfo, OauthMisc_AuthorizeQuery, OauthMisc_CallbackGoogleQuery, OauthMisc_ClientInfo,
  OauthMisc_ClientInfoQuery, OauthMisc_DownscopeBody, OauthMisc_JwkSet, OauthMisc_LoginGoogleQuery,
  OauthMisc_MintRestrictedBody, OauthMisc_OAuthError, OauthMisc_OpenIdConfiguration, OauthMisc_RedirectTo,
  OauthMisc_RestrictedToken, OauthMisc_RevokeBody, OauthMisc_UserInfo,
} from '../../schemas/oauth-misc';
import { onRequestGet as jwksGet } from '../handlers/oauth/.well-known/jwks.json';
import { onRequestGet as openidConfigGet } from '../handlers/oauth/.well-known/openid-configuration';
import { onRequestGet as authorizeGet } from '../handlers/oauth/authorize';
import { onRequestGet as authRequestGet, onRequestPost as authRequestDecide } from '../handlers/oauth/authorize-requests';
import { onRequestGet as callbackGoogleGet } from '../handlers/oauth/callback/google';
import { onRequestGet as clientInfoGet } from '../handlers/oauth/client-info';
import { onRequestPost as downscopePost } from '../handlers/oauth/downscope';
import { onRequestGet as loginGoogleGet } from '../handlers/oauth/login/google';
import { onRequestGet as logoutGet, onRequestPost as logoutPost } from '../handlers/oauth/logout';
import { onRequestPost as mintRestrictedPost } from '../handlers/oauth/mint-restricted';
import { onRequestPost as revokePost } from '../handlers/oauth/revoke';
import { onRequestGet as userinfoGet } from '../handlers/oauth/userinfo';

/**
 * OAuth 雜項端點。auth 模式對照舊 _middleware：`/api/oauth/*` 全部公開（端點自管認證），
 * 例外是 downscope（舊版也走 middleware 認證）。新增的 authorize requests 與 logout、userinfo 需要 bearer。
 * - revoke：client 認證（client_secret／public client_id）由 handler 自己做。
 * - mint-restricted：只收 TRIPLINE_API_SECRET，由 handler 自己做（不是 user bearer）。
 * `_id_token` 只是 lib（token endpoint 之後接），不登記路由。
 */
export function registerOauthMiscRoutes(app: OpenAPIHono<AppEnv>): void {
  const err = (description: string) => ({ description, schema: ApiError });
  const oerr = (description: string) => ({ description, schema: OauthMisc_OAuthError });

  legacyRoute(app, { method: 'get', path: '/api/oauth/.well-known/jwks.json', auth: 'none', handler: jwksGet, summary: 'OIDC JWKS',
    docs: { responses: { 200: { description: 'JWK Set（未設定簽章金鑰時 keys 為空陣列）', schema: OauthMisc_JwkSet } } } });
  legacyRoute(app, { method: 'get', path: '/api/oauth/.well-known/openid-configuration', auth: 'none', handler: openidConfigGet, summary: 'OIDC discovery',
    docs: { responses: { 200: { description: 'OIDC Discovery metadata', schema: OauthMisc_OpenIdConfiguration } } } });
  legacyRoute(app, { method: 'get', path: '/api/oauth/authorize', auth: 'none', handler: authorizeGet, summary: '第三方授權入口（存 AuthRequest 並導向 web）',
    docs: { query: OauthMisc_AuthorizeQuery, responses: {
      302: { description: '通過驗證：Location 為 `${WEB_ORIGIN}/oauth/authorize?request_id=<id>`；可導回 client 的驗證錯誤：Location 為 redirect_uri?error=...&error_description=...&state=...（無 JSON 內容）' },
      400: oerr('client／redirect_uri 有問題（不可導回 client），或 WEB_ORIGIN／PUBLIC_ORIGIN 未設定（server_error）'),
    } } });
  legacyRoute(app, { method: 'get', path: '/api/oauth/authorize/requests/:id', auth: 'required', handler: authRequestGet, summary: '授權請求的同意畫面資料',
    docs: { responses: {
      200: { description: '同意畫面用資料', schema: OauthMisc_AuthRequestInfo },
      400: err('授權請求不存在、已過期或已使用（DATA_VALIDATION）'),
      401: err('沒有有效 bearer'),
      403: err('service token 沒有使用者身份（PERM_DENIED）'),
    } } });
  const decide = (verb: string) => ({ responses: {
    200: { description: `${verb}：回帶 code 或 error 的 redirect_to（由 server 端存的 redirect_uri 組成）`, schema: OauthMisc_RedirectTo },
    400: err('授權請求不存在、已過期、已使用，或 client 已停用（DATA_VALIDATION）'),
    401: err('沒有有效 bearer'),
    403: err('service token 沒有使用者身份（PERM_DENIED）'),
  } });
  legacyRoute(app, { method: 'post', path: '/api/oauth/authorize/requests/:id/approve', auth: 'required', handler: authRequestDecide, summary: '同意授權（回 redirect_to）', docs: decide('同意') });
  legacyRoute(app, { method: 'post', path: '/api/oauth/authorize/requests/:id/deny', auth: 'required', handler: authRequestDecide, summary: '拒絕授權（回 redirect_to）', docs: decide('拒絕') });
  legacyRoute(app, { method: 'get', path: '/api/oauth/client-info', auth: 'none', handler: clientInfoGet, summary: 'client 公開資訊',
    docs: { query: OauthMisc_ClientInfoQuery, responses: {
      200: { description: '已註冊且啟用的 client 品牌資訊（snake_case）', schema: OauthMisc_ClientInfo },
      400: err('client_id 必填（DATA_VALIDATION）'),
      404: err('client 不存在或未啟用（DATA_NOT_FOUND）'),
    } } });
  legacyRoute(app, { method: 'post', path: '/api/oauth/downscope', auth: 'required', handler: downscopePost, summary: '換發單一行程的受限 token',
    docs: { body: OauthMisc_DownscopeBody, responses: {
      200: { description: '受限 access token（2 小時、無 refresh token）', schema: OauthMisc_RestrictedToken },
      400: err('trip_id 必填（DATA_VALIDATION）'),
      401: err('沒有有效 bearer'),
      403: err('service token、已受限 token，或對該行程無寫入權限（PERM_DENIED）'),
    } } });
  legacyRoute(app, { method: 'post', path: '/api/oauth/mint-restricted', auth: 'none', handler: mintRestrictedPost, summary: '（內部）由 request_id 簽發受限 token',
    docs: { body: OauthMisc_MintRestrictedBody, responses: {
      200: { description: '以 owner 身份簽發的受限 access token（2 小時）', schema: OauthMisc_RestrictedToken },
      400: err('request_id 必填（DATA_VALIDATION）'),
      401: err('Authorization 不是 TRIPLINE_API_SECRET（AUTH_REQUIRED）'),
      403: err('request 狀態不可 mint，或 owner 未授權（無 Consent）（PERM_DENIED）'),
      404: err('request 或 trip owner 不存在（DATA_NOT_FOUND）'),
    } } });
  legacyRoute(app, { method: 'post', path: '/api/oauth/revoke', auth: 'none', handler: revokePost, summary: 'RFC 7009 token revocation',
    docs: { body: OauthMisc_RevokeBody, responses: {
      200: { description: '一律 200 空內容（token 不存在、已撤銷或屬於別的 client 都不洩漏）' },
      400: oerr('缺 token（invalid_request）'),
      401: oerr('client 認證失敗（invalid_client）'),
      429: oerr('同一 IP 請求過多（rate_limited，帶 Retry-After）'),
    } } });
  const logoutDocs = { responses: {
    204: { description: '已撤銷目前 bearer 所屬 grant 的整個 token family（無內容）' },
    401: err('沒有有效 bearer'),
  } };
  legacyRoute(app, { method: 'get', path: '/api/oauth/logout', auth: 'required', handler: logoutGet, summary: '登出（撤銷目前 grant）', docs: logoutDocs });
  legacyRoute(app, { method: 'post', path: '/api/oauth/logout', auth: 'required', handler: logoutPost, summary: '登出（撤銷目前 grant）', docs: logoutDocs });
  legacyRoute(app, { method: 'get', path: '/api/oauth/userinfo', auth: 'required', handler: userinfoGet, summary: '目前使用者資料',
    docs: { responses: {
      200: { description: '使用者資料（camelCase）', schema: OauthMisc_UserInfo },
      401: err('沒有有效 bearer、service token 沒有使用者身份，或使用者已不存在'),
    } } });
  legacyRoute(app, { method: 'get', path: '/api/oauth/login/google', auth: 'none', handler: loginGoogleGet, summary: 'Google 登入（導向 Google）',
    docs: { query: OauthMisc_LoginGoogleQuery, responses: {
      302: { description: '導向 https://accounts.google.com/o/oauth2/v2/auth（query 含 response_type、client_id、redirect_uri、scope、state、nonce、code_challenge、code_challenge_method；purpose=account-delete 另帶 prompt=select_account、max_age=0、claims={"id_token":{"auth_time":{"essential":true}}}，state 5 分鐘有效）；可導回 client 的驗證錯誤：Location 為 redirect_uri?error=...（無 JSON 內容）' },
      400: oerr('client／redirect_uri 有問題（不可導回 client），或 dpop_jkt 格式不正確（invalid_request）'),
      403: err('purpose=account-delete：沒帶 challenge，或 challenge 不存在／已過期／client 與環境不符／狀態不是 pending 或 started（ACCOUNT_DELETE_REAUTH_REQUIRED）'),
      503: err('尚未設定 Google 登入（OAUTH_NOT_CONFIGURED）'),
    } } });
  legacyRoute(app, { method: 'get', path: '/api/oauth/callback/google', auth: 'none', handler: callbackGoogleGet, summary: 'Google 登入 callback',
    docs: { query: OauthMisc_CallbackGoogleQuery, responses: {
      302: { description: '成功：Location 為 client 註冊的 redirect_uri?code=<我們的 code>&state=...；帳號刪除重新驗證（state 帶 reauth）：Location 為 mobile callback?challenge_id=…&status=verified，任何失敗為 status=failed（不發 code、不建 user）；使用者在 Google 取消：redirect_uri?error=access_denied&state=...（無 JSON 內容）' },
      400: err('state 無效、過期或已使用（OAUTH_INVALID_STATE），或 Google email 未驗證（OAUTH_EMAIL_UNVERIFIED）'),
      401: err('Google id_token 驗證失敗或 nonce 不符（OAUTH_INVALID_ID_TOKEN）'),
      403: err('帳號已停用（OAUTH_ACCOUNT_SUSPENDED）；帳號刪除重新驗證失敗且沒有可導回的 mobile challenge（ACCOUNT_DELETE_REAUTH_REQUIRED）'),
      409: err('email 已註冊但未驗證（OAUTH_EMAIL_CONFLICT）'),
      502: err('向 Google 換 token 失敗（OAUTH_TOKEN_EXCHANGE_FAILED）'),
      503: err('尚未設定 Google 登入（OAUTH_NOT_CONFIGURED）'),
    } } });
}
