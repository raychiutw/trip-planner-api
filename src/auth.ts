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
import { checkDpopProof, dpopJtiInsertForToken, type DpopChecked } from './lib/dpop';
import { classifyDpopFailure, recordSecurityEvent, type SecurityEvent } from './lib/security-events';
import { isFirstPartyClientId } from './lib/first-party';
import type { AdapterPayload } from './lib/oauth-d1-adapter';
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

interface TokenRow { payload: string; expires_at: number; u_email: string | null; u_status: string | null; ca_first_party: number | null }

/**
 * 一次 D1 往返解出 token → 使用者 → client（原本是 token、users 兩次循序查詢，requireAccountUser 還要再查一次 client_apps）。
 * dpop 有給時，jti 登記語句與查詢放同一個 batch（登記只在 token 有效且綁定這把金鑰時才寫入，見 dpopJtiInsertForToken）。
 */
async function resolveToken(
  db: D1Database,
  token: string,
  firstPartyOverride?: string,
  dpop?: { jkt: string; jti: string; expiresAt: number },
): Promise<{ auth: AuthData; boundJkt: string | null; jtiFresh: boolean } | null> {
  const select = db
    .prepare(
      `SELECT m.payload, m.expires_at, u.email AS u_email, u.status AS u_status, ca.first_party AS ca_first_party
         FROM oauth_models m
         LEFT JOIN users u ON u.id = json_extract(m.payload, '$.user_id')
         LEFT JOIN client_apps ca ON ca.client_id = json_extract(m.payload, '$.client_id')
        WHERE m.name = 'AccessToken' AND m.id = ?`,
    )
    .bind(token);
  let jtiFresh = false;
  let rows: TokenRow[];
  if (dpop) {
    const [ins, sel] = await db.batch([dpopJtiInsertForToken(db, dpop, token), select]);
    jtiFresh = (ins?.meta?.changes ?? 0) === 1;
    rows = (sel?.results ?? []) as TokenRow[];
  } else {
    rows = ((await select.all<TokenRow>()).results ?? []) as TokenRow[];
  }
  const found = rows[0];
  if (!found || found.expires_at < Date.now()) return null; // 過期視為不存在（同 D1Adapter.find）
  const row = JSON.parse(found.payload) as AdapterPayload;
  if (!row || typeof row !== 'object' || typeof row.client_id !== 'string' || !('user_id' in row)) return null;

  const clientId = row.client_id;
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [];
  const restrictTrip = typeof row.restrict_trip === 'string' ? row.restrict_trip : undefined;
  const isFirstPartyClient = isFirstPartyClientId(clientId, firstPartyOverride);
  const grantId = typeof row.grantId === 'string' ? row.grantId : undefined;
  const cnf = row.cnf as { jkt?: unknown } | undefined;
  const boundJkt = typeof cnf?.jkt === 'string' ? cnf.jkt : null;
  const clientFirstParty = found.ca_first_party ?? null;

  if (row.user_id === null) {
    // service token：不繼承任何 email；維運權限靠 ops scope
    return { auth: { email: `service:${clientId}`, userId: null, isServiceToken: true, scopes, clientId, isFirstPartyClient, restrictTrip, clientFirstParty }, boundJkt, jtiFresh };
  }
  if (typeof row.user_id !== 'string') return null;

  // 使用者不存在或被停權 → 拒絕（舊入口是 best-effort 放行；新入口 fail-closed）
  if (found.u_email === null || found.u_status !== 'active') return null;
  return { auth: { email: found.u_email.trim().toLowerCase(), userId: row.user_id, isServiceToken: false, scopes, clientId, grantId, isFirstPartyClient, restrictTrip, clientFirstParty }, boundJkt, jtiFresh };
}

export const bearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (header === undefined) return next();

  /** 失敗：寫稽核（必要時告警）後回 401；稽核失敗不影響回應。 */
  const fail = async (ev: SecurityEvent, scheme: 'Bearer' | 'DPoP' = 'Bearer'): Promise<Response> => {
    await recordSecurityEvent(c.env, c.req.raw, ev);
    return unauthorized(scheme);
  };

  // 帶 Origin 的 Bearer 請求由全域 cors middleware 先擋（不在白名單 → 403），這裡不重複。
  const parsed = parseAuthorization(header);
  if (!parsed) return fail({ kind: 'auth_failure', reason: 'malformed_authorization' });
  const { scheme, token } = parsed;
  let resolved: Awaited<ReturnType<typeof resolveToken>> = null;
  try {
    // proof 的純運算驗證（簽章、ath、時間窗）先做；要不要「採信」它的結果等 token 解出來再決定，
    // 所以無效 token 搭配壞 proof 仍然只記 invalid_token（不會變成會告警的 signature_error）。
    const checked: DpopChecked | undefined = scheme === 'DPoP' ? await checkDpopProof(c.req.raw, { accessToken: token }) : undefined;
    resolved = await resolveToken(c.env.DB, token, (c.env as { TP_REQUEST_CLIENT_ID?: string }).TP_REQUEST_CLIENT_ID, checked?.ok ? checked : undefined);
    if (resolved) {
      const who = { userId: resolved.auth.userId, clientId: resolved.auth.clientId };
      if (scheme === 'Bearer') {
        // 綁定金鑰的 token 不可當 Bearer 用（外洩的 token 不能降級）
        if (resolved.boundJkt) return fail({ kind: 'auth_failure', reason: 'dpop_required', ...who }, 'DPoP');
      } else {
        // DPoP scheme 只收綁定的 token，且 proof 的金鑰必須就是綁定的那把
        if (!resolved.boundJkt) return fail({ kind: 'auth_failure', reason: 'dpop_unbound', ...who }, 'DPoP');
        if (!checked!.ok) return fail({ ...classifyDpopFailure(checked!.reason), ...who }, 'DPoP');
        if (checked!.jkt !== resolved.boundJkt) return fail({ kind: 'signature_error', reason: 'key_mismatch', ...who }, 'DPoP');
        // jti 已存在 = 重放（登記語句與查詢同批送出；token 有效且金鑰相符才會走到這裡，所以 0 筆只可能是重放）
        if (!resolved.jtiFresh) return fail({ ...classifyDpopFailure('replay'), ...who }, 'DPoP');
      }
    }
  } catch {
    resolved = null; // fail-closed
  }
  if (!resolved) return fail({ kind: 'auth_failure', reason: 'invalid_token' }, scheme);
  const auth = resolved.auth;
  c.set('auth', auth);
  c.set('accessToken', token);
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
