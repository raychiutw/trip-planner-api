/**
 * oauth-misc 路由組的 schema（OpenAPI 文件與契約測試共用）。
 * 這組是 OAuth wire 端點：部分錯誤是 RFC 6749 的扁平 `{ error, error_description }`，
 * 其餘（AppError 丟出的）是共用的巢狀 ApiError。兩種都依 handler 實際行為標註在各路由。
 */
import { z } from '@hono/zod-openapi';

/** RFC 6749／7009 的扁平錯誤（oauthErrorResponse；revoke 的 429 也是同形狀）。 */
export const OauthMisc_OAuthError = z.object({
  error: z.string().openapi({ example: 'invalid_request' }),
  error_description: z.string(),
}).openapi('OauthMisc_OAuthError');

/** JWK（RFC 7517，RSA 公鑰）。 */
const OauthMisc_Jwk = z.object({
  kty: z.string().openapi({ example: 'RSA' }),
  use: z.string().openapi({ example: 'sig' }),
  kid: z.string(),
  alg: z.string().openapi({ example: 'RS256' }),
  n: z.string(),
  e: z.string(),
}).openapi('OauthMisc_Jwk');

/** JWK Set。未設定 OAUTH_SIGNING_PRIVATE_KEY 或金鑰格式錯誤時 keys 為空陣列（仍回 200）。 */
export const OauthMisc_JwkSet = z.object({ keys: z.array(OauthMisc_Jwk) }).openapi('OauthMisc_JwkSet');

/** OIDC Discovery（OpenID Provider Metadata）；registration_endpoint／end_session_endpoint 目前不輸出。 */
export const OauthMisc_OpenIdConfiguration = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  userinfo_endpoint: z.string(),
  jwks_uri: z.string(),
  revocation_endpoint: z.string(),
  scopes_supported: z.array(z.string()),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  subject_types_supported: z.array(z.string()),
  id_token_signing_alg_values_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  claims_supported: z.array(z.string()),
}).openapi('OauthMisc_OpenIdConfiguration');

/** GET /authorize 的 query（缺少或不合法時由 handler 回 400 或 302 error，文件不在執行期驗證）。 */
export const OauthMisc_AuthorizeQuery = z.object({
  response_type: z.string().optional().openapi({ example: 'code' }),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional().openapi({ example: 'S256' }),
  prompt: z.string().optional(),
});

export const OauthMisc_AuthRequestInfo = z.object({
  client: z.object({ client_id: z.string(), app_name: z.string() }),
  scopes: z.array(z.string()),
  needs_consent: z.boolean(),
  expires_at: z.string().openapi({ description: 'ISO 8601' }),
}).openapi('OauthMisc_AuthRequestInfo');

/** approve／deny 的結果：一律是 server 端存的已驗證 redirect_uri 加上 code 或 error 參數。 */
export const OauthMisc_RedirectTo = z.object({ redirect_to: z.string() }).openapi('OauthMisc_RedirectTo');

/** 注意 snake_case（rawJson，不經 camelCase 轉換）。 */
export const OauthMisc_ClientInfo = z.object({
  app_name: z.string(),
  app_description: z.string().nullable(),
  app_logo_url: z.string().nullable(),
  homepage_url: z.string().nullable(),
}).openapi('OauthMisc_ClientInfo');

export const OauthMisc_ClientInfoQuery = z.object({ client_id: z.string() });

/** downscope 與 mint-restricted 的回應相同。 */
export const OauthMisc_RestrictedToken = z.object({
  access_token: z.string(),
  token_type: z.string().openapi({ example: 'Bearer' }),
  expires_in: z.number().int(),
  restrict_trip: z.string(),
}).openapi('OauthMisc_RestrictedToken');

/** handler 同時接受 form 與 JSON，文件以 JSON 描述。 */
export const OauthMisc_DownscopeBody = z.object({ trip_id: z.string() });
export const OauthMisc_MintRestrictedBody = z.object({ request_id: z.union([z.string(), z.number()]) });

/** RFC 7009；handler 同時接受 form 與 JSON，文件以 JSON 描述。 */
export const OauthMisc_RevokeBody = z.object({
  token: z.string(),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  client_id: z.string().optional().openapi({ description: '也可改用 HTTP Basic 帶 client 認證' }),
  client_secret: z.string().optional(),
});

/** 注意 camelCase（與其他 oauth 端點的 snake_case 不一致，照現況）。 */
export const OauthMisc_UserInfo = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
}).openapi('OauthMisc_UserInfo');

export const OauthMisc_LoginGoogleQuery = z.object({
  purpose: z.literal('account-delete').optional().openapi({ description: '帳號刪除的 Google 重新驗證：帶 purpose=account-delete 與 challenge，其餘參數不需要（見 /api/account/delete-reauth）' }),
  challenge: z.string().optional().openapi({ description: 'purpose=account-delete 時必填：POST /api/account/delete-reauth 發出的 challengeId' }),
  client_id: z.string().optional().openapi({ description: '一般登入必填' }),
  redirect_uri: z.string().optional().openapi({ description: '一般登入必填' }),
  code_challenge: z.string().optional().openapi({ description: '一般登入必填；S256' }),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  dpop_jkt: z.string().optional().openapi({ description: '43 字元 base64url；第一方 public client 可綁 DPoP' }),
});

export const OauthMisc_CallbackGoogleQuery = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});
