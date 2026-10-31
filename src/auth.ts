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
import { verifyDpopProof } from './lib/dpop';
import { isFirstPartyClientId } from './lib/first-party';
import { D1Adapter, type AdapterPayload } from './lib/oauth-d1-adapter';
import type { AuthData } from './types';

/** 合法 opaque token 的長度上限；超過直接拒絕，不打 DB。 */
const MAX_TOKEN_LENGTH = 512;

function unauthorized(scheme: 'Bearer' | 'DPoP' = 'Bearer'): Response {
  const res = errorResponse(new AppError('AUTH_REQUIRED'));
  res.headers.set('WWW-Authenticate', scheme === 'DPoP' ? 'DPoP algs="ES256"' : 'Bearer');
  return res;
}

/** `Authorization: Bearer <token>` 或 `DPoP <token>`（scheme 不分大小寫）。 */
function parseAuthorization(header: string): { scheme: 'Bearer' | 'DPoP'; token: string } | null {
  const m = /^(Bearer|DPoP)[ \t]+(.*)$/i.exec(header);
  const token = m?.[2]?.trim();
  if (!m || !token || token.length > MAX_TOKEN_LENGTH) return null;
  return { scheme: m[1]!.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer', token };
}

async function resolveToken(db: D1Database, token: string, firstPartyOverride?: string): Promise<{ auth: AuthData; boundJkt: string | null } | null> {
  const row = (await new D1Adapter(db, 'AccessToken').find(token)) as AdapterPayload | undefined;
  if (!row || typeof row !== 'object' || typeof row.client_id !== 'string' || !('user_id' in row)) return null;

  const clientId = row.client_id;
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [];
  const restrictTrip = typeof row.restrict_trip === 'string' ? row.restrict_trip : undefined;
  const isFirstPartyClient = isFirstPartyClientId(clientId, firstPartyOverride);
  const cnf = row.cnf as { jkt?: unknown } | undefined;
  const boundJkt = typeof cnf?.jkt === 'string' ? cnf.jkt : null;

  if (row.user_id === null) {
    // service token：不繼承任何 email；維運權限靠 ops scope
    return { auth: { email: `service:${clientId}`, userId: null, isServiceToken: true, scopes, clientId, isFirstPartyClient, restrictTrip }, boundJkt };
  }
  if (typeof row.user_id !== 'string') return null;

  const user = await db.prepare('SELECT email, status FROM users WHERE id = ?').bind(row.user_id).first<{ email: string; status: string }>();
  // 使用者不存在或被停權 → 拒絕（舊入口是 best-effort 放行；新入口 fail-closed）
  if (!user || user.status !== 'active') return null;
  return { auth: { email: user.email.trim().toLowerCase(), userId: row.user_id, isServiceToken: false, scopes, clientId, isFirstPartyClient, restrictTrip }, boundJkt };
}

export const bearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (header === undefined) return next();

  // 帶 Origin 的 Bearer 請求由全域 cors middleware 先擋（不在白名單 → 403），這裡不重複。
  const parsed = parseAuthorization(header);
  if (!parsed) return unauthorized();
  const { scheme, token } = parsed;
  let resolved: Awaited<ReturnType<typeof resolveToken>> = null;
  try {
    resolved = await resolveToken(c.env.DB, token, (c.env as { TP_REQUEST_CLIENT_ID?: string }).TP_REQUEST_CLIENT_ID);
    if (resolved) {
      if (scheme === 'Bearer') {
        // 綁定金鑰的 token 不可當 Bearer 用（外洩的 token 不能降級）
        if (resolved.boundJkt) return unauthorized('DPoP');
      } else {
        // DPoP scheme 只收綁定的 token，且 proof 的金鑰必須就是綁定的那把
        if (!resolved.boundJkt) return unauthorized('DPoP');
        const proof = await verifyDpopProof(c.req.raw, c.env.DB, { accessToken: token });
        if (!proof.ok || proof.jkt !== resolved.boundJkt) return unauthorized('DPoP');
      }
    }
  } catch {
    resolved = null; // fail-closed
  }
  if (!resolved) return unauthorized(scheme);
  const auth = resolved.auth;
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
