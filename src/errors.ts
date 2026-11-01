/**
 * 錯誤處理（拆分 T9）。
 *
 * 兩種形狀並存，依消費者而定（與舊入口一致）：
 * - 使用者面向的 endpoint：巢狀 `{ error: { code, message, detail? } }`，client 以 code 分流。
 * - OAuth wire endpoints（RFC 6749/7009）：扁平 `{ error, error_description }`。
 *
 * 安全原則：5xx 與未預期例外一律只回通用訊息；細節只進伺服器 log，以 request id 對照。
 */
import { ERROR_MESSAGES } from './types';
import type { ErrorCodeType } from './types';

export const STATUS_MAP: Partial<Record<ErrorCodeType, number>> = {
  AUTH_REQUIRED: 401,
  AUTH_EXPIRED: 401,
  AUTH_INVALID: 401,
  PERM_DENIED: 403,
  PERM_ADMIN_ONLY: 403,
  PERM_NOT_OWNER: 403,
  DATA_NOT_FOUND: 404,
  DATA_VALIDATION: 400,
  DATA_CONFLICT: 409,
  DATA_ENCODING: 400,
  DATA_SAVE_FAILED: 500,
  SYS_INTERNAL: 500,
  SYS_DB_ERROR: 503,
  SYS_RATE_LIMIT: 429,
  COMPANION_QUOTA_EXCEEDED: 409,
  MAPS_LOCKED: 503,
  MAPS_UPSTREAM_FAILED: 502,
  STALE_ENTRY: 409,
  DUPLICATE_POI: 409,
  POI_NOT_ALTERNATE: 404,
  MISSING_MASTER: 400,
  INVALID_ORDER: 422,
  TRIP_EMPTY: 422,
  INVITATION_TOKEN_MISSING: 400,
  INVITATION_INVALID: 410,
  INVITATION_ACCEPTED: 410,
  INVITATION_EXPIRED: 410,
  SERVER_MISCONFIG: 500,
  LOGIN_INVALID_INPUT: 400,
  LOGIN_INVALID: 401,
  LOGIN_RATE_LIMITED: 429,
  SIGNUP_INVALID_EMAIL: 400,
  SIGNUP_PASSWORD_TOO_SHORT: 400,
  SIGNUP_PASSWORD_FORMAT: 400,
  SIGNUP_EMAIL_TAKEN: 409,
  SIGNUP_RATE_LIMITED: 429,
  RESET_TOKEN_MISSING: 400,
  RESET_PASSWORD_TOO_SHORT: 400,
  RESET_TOKEN_INVALID: 400,
  RESET_PASSWORD_FORMAT: 400,
  RESET_RATE_LIMITED: 429,
  ACCOUNT_DELETE_CONFIRM_REQUIRED: 400,
  ACCOUNT_DELETE_PASSWORD_INVALID: 401,
  ACCOUNT_DELETE_REAUTH_REQUIRED: 403,
  SIGNUP_CONSENT_REQUIRED: 400,
  NOTES_AI_INVALID_OUTPUT: 422,
  NOTES_AI_NO_VALID_ITEMS: 422,
  NOTES_AI_JOB_STALE: 409,
  NOTES_AI_NOT_REASSIGNABLE: 409,
  NOTES_AI_APPLY_FAILED: 500,
};

export class AppError extends Error {
  readonly code: ErrorCodeType;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ErrorCodeType, detail?: string) {
    super(ERROR_MESSAGES[code] || code);
    this.code = code;
    this.status = STATUS_MAP[code] ?? 500;
    this.detail = detail;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** AppError → 巢狀錯誤回應。detail 只給 4xx（5xx 的 detail 可能含 SQL、路徑）。 */
export function errorResponse(err: AppError): Response {
  const detail = err.status < 500 && err.detail ? err.detail : undefined;
  return new Response(JSON.stringify({ error: { code: err.code, message: err.message, detail } }), {
    status: err.status,
    headers: JSON_HEADERS,
  });
}

/** RFC 6749/7009 扁平錯誤。 */
export function oauthErrorResponse(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
  });
}

/** 429 + Retry-After；body 形狀由呼叫端決定（tripline 風格或 OAuth 風格）。 */
export function buildRateLimitResponse(retryAfterSeconds: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { ...JSON_HEADERS, 'cache-control': 'no-store', 'Retry-After': String(retryAfterSeconds) },
  });
}
