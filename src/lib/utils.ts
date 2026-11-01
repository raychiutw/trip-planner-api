/**
 * API 共用工具函式
 */

import type { AuthData } from '../env';
import { AppError } from '../errors';

/** snake_case → camelCase key conversion */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Recursively convert all object keys from snake_case to camelCase */
function deepCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepCamel);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamel(key)] = deepCamel(val);
    }
    return result;
  }
  return obj;
}

/** JSON response with automatic deep snake_case → camelCase key conversion */
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(deepCamel(data)), { status, headers: { 'Content-Type': 'application/json' } });
}

/** JSON response WITHOUT key conversion — for OAuth wire format that requires
 *  snake_case keys (RFC 6749 access_token / client_id etc.) */
export function rawJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 型別安全的 auth 擷取 */
export function getAuth(context: { data: unknown }): AuthData | null {
  return ((context.data as Record<string, unknown>)?.auth as AuthData) ?? null;
}

/** 解析 JSON body，失敗 throw AppError('DATA_VALIDATION') */
export async function parseJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new AppError('DATA_VALIDATION', 'JSON 格式無效');
  }
}

/** 驗證數值 URL 參數，回傳正整數或 null */
export function parseIntParam(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * Generate a base64url opaque token from `byteLen` random bytes (default 32 = ~256 bits).
 * Used for session cookies, OAuth state, authorization codes, refresh tokens, email
 * verification tokens, password reset tokens — anything that needs an unguessable
 * URL-safe identifier. Centralised here so a single bug fix (e.g. unfilled bytes)
 * applies everywhere.
 */
/** prod trust-anchor 的標準 origin — PUBLIC_ORIGIN 未設時的 fail-safe fallback（非 request Host）。 */
export const CANONICAL_PROD_ORIGIN = 'https://trip-planner-dby.pages.dev';

/**
 * v2.33.59 round 13: Return trusted origin for outbound email links / OIDC issuer。
 *
 * 之前 `new URL(context.request.url).origin` 信 attacker-spoofable Host header —
 * CF Pages edge 通常會 normalise，但 zero-trust 不假設。
 *
 * Prefer `env.PUBLIC_ORIGIN` if set (prod: `https://trip-planner-dby.pages.dev`)。
 *
 * v2.55.86: **production 下絕不從 request Host 推導 trust anchor**。issuer / email /
 * 邀請連結是 trust anchor，不該隱性依賴 CF 的 Host normalise。PUBLIC_ORIGIN 未設時，
 * production 回 `CANONICAL_PROD_ORIGIN` 常數（非 request origin）並 warn；探針實測 prod
 * 的 request-origin 已 = 標準 origin（CF 擋不符 Host、不理 X-Forwarded-Host），故此改
 * 對現況零行為變化，只是把隱性信任變顯性、未設時可見。dev/preview 維持 request-origin 彈性。
 */
let warnedMissingPublicOrigin = false;

export function getPublicOrigin(
  env: { PUBLIC_ORIGIN?: string; ENVIRONMENT?: string },
  request: Request,
): string {
  if (env.PUBLIC_ORIGIN && env.PUBLIC_ORIGIN.length > 0) {
    return env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  }
  // Production without PUBLIC_ORIGIN → canonical origin, never the request Host.
  // `ENVIRONMENT === 'production'` is the SAME wrangler.toml-enforced invariant the
  // SEC-6 dev-mock-auth guard already trusts (_middleware.ts): were it unset in prod,
  // that guard fails-open into a full auth bypass first — so this deny-list check is
  // no weaker than the app's existing trust model. dev/preview keep request-origin.
  if (env.ENVIRONMENT === 'production') {
    if (!warnedMissingPublicOrigin) {
      warnedMissingPublicOrigin = true; // once per isolate — no per-request log spam
      console.warn(
        '[getPublicOrigin] PUBLIC_ORIGIN unset in production — using canonical fallback; set PUBLIC_ORIGIN to make the trust anchor explicit.',
      );
    }
    return CANONICAL_PROD_ORIGIN;
  }
  return new URL(request.url).origin;
}

/**
 * OIDC issuer identifier — 單一真相，discovery doc 與 id_token 的 `iss` 共用。
 *
 * **必須由這裡集中產生。** 兩邊各自組字串會 drift：v2.55.84 以前
 * `openid-configuration.ts` 宣告 `<origin>/api/oauth`、`_id_token.ts` 卻簽
 * `<origin>`（無後綴），任何照 OIDC Core 3.1.3.7 #2 驗 `iss` 的 client 都會把
 * 合法 token 判為無效。該檔的註解甚至預言了要 cross-check 卻漏了 issuer 本身。
 *
 * 後綴不可省：OIDC Discovery §4 規定 discovery doc 必須位於
 * `{issuer}/.well-known/openid-configuration` —— 我們的 doc 掛在
 * `/api/oauth/.well-known/openid-configuration`，所以 issuer 就是 `/api/oauth`。
 * 拔掉後綴會讓 doc 的位置變成不合規（根路徑回的是 SPA HTML）。
 */
export function getOidcIssuer(
  env: { PUBLIC_ORIGIN?: string; ENVIRONMENT?: string },
  request: Request,
): string {
  return `${getPublicOrigin(env, request)}/api/oauth`;
}





/**
 * Parse request body as form-urlencoded OR JSON. Returns flat record. Used by
 * OAuth endpoints that accept both content types per RFC 6749 §3.2.
 */
export async function parseFormOrJson<T = Record<string, string>>(
  request: Request,
): Promise<T> {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out as unknown as T;
  }
  if (ct.includes('application/json')) {
    return (await request.json()) as T;
  }
  return {} as T;
}

/**
 * Parse HTTP Basic auth header for client credentials (RFC 6749 §2.3.1).
 * Returns null if the header is missing or malformed.
 */
export function parseBasicAuth(request: Request): { id: string; secret: string } | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) return null;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** 動態 SQL UPDATE clause builder */
export function buildUpdateClause(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): { fields: string[]; setClauses: string; values: unknown[] } | null {
  const fields = Object.keys(body).filter(k => (allowedFields as readonly string[]).includes(k));
  if (fields.length === 0) return null;
  const setClauses = [...fields.map(f => `${f} = ?`), 'updated_at = CURRENT_TIMESTAMP'].join(', ');
  const values = fields.map(f => body[f]);
  return { fields, setClauses, values };
}

export { generateOpaqueToken, sha256Base64 } from './crypto';
