/**
 * Bearer 認證（拆分 T9）。
 *
 * api 只認 `Authorization: Bearer <opaque access token>`（不用 cookie）。
 * - bearerAuth：有帶 Authorization 就解析；解析失敗一律 401（不降級成匿名）；沒帶則不動。
 * - requireAuth：沒有 auth 就 401。
 * - optionalAuth：公開讀取端點用（沒帶 token 放行，auth 為空）。
 *
 * 失敗一律同一個形狀（AUTH_REQUIRED），不洩漏「不存在／過期／被停權」的差別。
 * 任何例外（含 DB 錯誤）都 fail-closed。
 */
import type { MiddlewareHandler } from 'hono';
import { AppError, errorResponse } from './errors';
import type { AppEnv } from './env';
import { isFirstPartyClientId } from './lib/first-party';
import { D1Adapter, type AdapterPayload } from './lib/oauth-d1-adapter';
import type { AuthData } from './types';

/** 合法 opaque token 的長度上限；超過直接拒絕，不打 DB。 */
const MAX_TOKEN_LENGTH = 512;

function unauthorized(): Response {
  const res = errorResponse(new AppError('AUTH_REQUIRED'));
  res.headers.set('WWW-Authenticate', 'Bearer');
  return res;
}

function parseBearer(header: string): string | null {
  const m = /^Bearer[ \t]+(.*)$/i.exec(header);
  const token = m?.[1]?.trim();
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

async function resolveToken(db: D1Database, token: string, firstPartyOverride?: string): Promise<AuthData | null> {
  const row = (await new D1Adapter(db, 'AccessToken').find(token)) as AdapterPayload | undefined;
  if (!row || typeof row !== 'object' || typeof row.client_id !== 'string' || !('user_id' in row)) return null;

  const clientId = row.client_id;
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [];
  const restrictTrip = typeof row.restrict_trip === 'string' ? row.restrict_trip : undefined;
  const isFirstPartyClient = isFirstPartyClientId(clientId, firstPartyOverride);

  if (row.user_id === null) {
    // service token：不繼承任何 email；維運權限靠 ops scope
    return { email: `service:${clientId}`, userId: null, isServiceToken: true, scopes, clientId, isFirstPartyClient, restrictTrip };
  }
  if (typeof row.user_id !== 'string') return null;

  const user = await db.prepare('SELECT email, status FROM users WHERE id = ?').bind(row.user_id).first<{ email: string; status: string }>();
  // 使用者不存在或被停權 → 拒絕（舊入口是 best-effort 放行；新入口 fail-closed）
  if (!user || user.status !== 'active') return null;
  return { email: user.email.trim().toLowerCase(), userId: row.user_id, isServiceToken: false, scopes, clientId, isFirstPartyClient, restrictTrip };
}

export const bearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (header === undefined) return next();

  // 帶 Origin 的 Bearer 請求由全域 cors middleware 先擋（不在白名單 → 403），這裡不重複。
  const token = parseBearer(header);
  if (!token) return unauthorized();
  let auth: AuthData | null = null;
  try {
    auth = await resolveToken(c.env.DB, token, (c.env as { TP_REQUEST_CLIENT_ID?: string }).TP_REQUEST_CLIENT_ID);
  } catch {
    auth = null; // fail-closed
  }
  if (!auth) return unauthorized();
  c.set('auth', auth);
  return next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('auth')) return unauthorized();
  return next();
};

export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('auth')) c.set('auth', null);
  return next();
};
