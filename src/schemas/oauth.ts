/**
 * 純 Hono 路由（token／login／sse-ticket）的請求與回應 schema。
 * 同一份 schema 用於：OpenAPI 文件（T19 產生 client）與契約測試（實際回應必須能通過它）。
 */
import { z } from '@hono/zod-openapi';

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/** OAuth wire 端點的扁平錯誤（RFC 6749 §5.2）。 */
export const OAuthError = z.object({
  error: z.string().openapi({ example: 'invalid_grant' }),
  error_description: z.string(),
}).openapi('OAuthError');

/** 使用者面向端點的巢狀錯誤。 */
export const NestedError = z.object({
  error: z.object({ code: z.string().openapi({ example: 'LOGIN_INVALID' }), message: z.string(), detail: z.string().optional() }),
}).openapi('ApiError');

export const LoginRequest = z.object({
  email: z.string(),
  password: z.string().min(1).max(1024),
  client_id: z.string().openapi({ example: 'tripline-web' }),
  code_challenge: z.string().regex(B64URL_43).openapi({ description: 'PKCE S256 challenge（base64url，43 字元）' }),
  code_challenge_method: z.literal('S256'),
  scope: z.string().optional().openapi({ example: 'openid profile email' }),
  dpop_jkt: z.string().regex(B64URL_43).optional().openapi({ description: '把 code 綁定到這把 DPoP 金鑰（RFC 7638 thumbprint）' }),
}).openapi('LoginRequest');

export const LoginResponse = z.object({
  code: z.string(),
  expires_in: z.number().int().positive().openapi({ example: 60 }),
}).openapi('LoginResponse');

export const TokenRequest = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token', 'client_credentials']),
  client_id: z.string().optional().openapi({ description: '也可用 HTTP Basic' }),
  client_secret: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional().openapi({ description: '第一方直接登入換的 code 不可帶' }),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
}).openapi('TokenRequest');

export const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional().openapi({ description: 'client_credentials 不發 refresh token' }),
  token_type: z.enum(['Bearer', 'DPoP']),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  id_token: z.string().optional().openapi({ description: 'scope 含 openid 且伺服器有簽章 key 時才有' }),
}).openapi('TokenResponse');

export const SseTicketResponse = z.object({
  ticket: z.string(),
  expires_in: z.number().int().positive().openapi({ example: 30 }),
}).openapi('SseTicketResponse');
