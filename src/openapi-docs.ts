/**
 * 把「純 Hono」路由（token／login／sse-ticket／events）登記進 OpenAPI（不改變路由本身的行為）。
 * schema 在 src/schemas/oauth.ts，並有契約測試保證實際回應符合。
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type { AppEnv } from './env';
import { LoginRequest, LoginResponse, NestedError, OAuthError, SseTicketResponse, TokenRequest, TokenResponse } from './schemas/oauth';

const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const idParam = z.object({ id: z.string().regex(/^\d+$/).openapi({ param: { name: 'id', in: 'path' }, example: '123' }) });

export function registerOpenApiDocs(app: OpenAPIHono<AppEnv>): void {
  const reg = app.openAPIRegistry;
  reg.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer <access token>；DPoP 綁定的 token 改用 `Authorization: DPoP` 並附 `DPoP` proof header' });

  reg.registerPath({
    method: 'post', path: '/api/oauth/token', summary: 'OAuth token endpoint（authorization_code＋PKCE、refresh_token、client_credentials；可選 DPoP 綁定）',
    request: { body: { required: true, content: { 'application/x-www-form-urlencoded': { schema: TokenRequest }, 'application/json': { schema: TokenRequest } } } },
    responses: {
      200: { description: 'Token 簽發成功（帶 DPoP 時 token_type 為 DPoP）', content: json(TokenResponse) },
      400: { description: 'invalid_request／invalid_grant／invalid_scope／unsupported_grant_type／invalid_dpop_proof；mobile client（tripline-mobile／-uat／-dev）與環境不符，或 authorization_code 的 redirect_uri 不是該環境的精確 callback（invalid_client，任何 grant 都檢查）', content: json(OAuthError) },
      401: { description: 'invalid_client／unauthorized_client', content: json(OAuthError) },
      429: { description: 'rate_limited（附 Retry-After）', content: json(OAuthError) },
    },
  });

  reg.registerPath({
    method: 'post', path: '/api/oauth/login', summary: '第一方（web／行動端）帳密登入，換 authorization code（不跳轉、不發 cookie）',
    request: { body: { required: true, content: json(LoginRequest) } },
    responses: {
      200: { description: '回 code；之後到 token endpoint 以 code_verifier 兌換', content: json(LoginResponse) },
      400: { description: 'LOGIN_INVALID_INPUT（含非第一方 client）', content: json(NestedError) },
      401: { description: 'LOGIN_INVALID（帳號不存在、密碼錯、停權一律相同）', content: json(NestedError) },
      429: { description: 'LOGIN_RATE_LIMITED：IP × 帳號錯 10 次鎖 10 分鐘、再錯 10 次鎖 30 分鐘（附 Retry-After）', content: json(NestedError) },
    },
  });

  reg.registerPath({
    method: 'post', path: '/api/requests/{id}/sse-ticket', summary: '換取一次性 SSE ticket（30 秒、單次、綁定該 request）',
    security: [{ bearerAuth: [] }], request: { params: idParam },
    responses: {
      200: { description: 'ticket', content: json(SseTicketResponse) },
      401: { description: 'AUTH_REQUIRED', content: json(NestedError) },
      404: { description: 'request 不存在或無權限（不區分）', content: json(NestedError) },
      429: { description: 'SYS_RATE_LIMIT', content: json(NestedError) },
    },
  });

  reg.registerPath({
    method: 'get', path: '/api/requests/{id}/events', summary: '請求狀態即時推送（SSE）。以 `?ticket=` 兌換，或直接帶 Authorization；憑證到期／撤銷時送 `event: reconnect`',
    security: [{ bearerAuth: [] }, {}],
    request: { params: idParam, query: z.object({ ticket: z.string().optional() }) },
    responses: {
      200: { description: 'text/event-stream；`id:` 為狀態快照；`event: reconnect` 的 data.reason 為 token_expired／grant_revoked／max_duration', content: { 'text/event-stream': { schema: z.string() } } },
      401: { description: 'AUTH_REQUIRED（ticket 無效、過期、已用過、跨 request 一律相同）', content: json(NestedError) },
      404: { description: 'DATA_NOT_FOUND', content: json(NestedError) },
    },
  });
}
