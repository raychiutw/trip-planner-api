/**
 * 第一方登入的共用簽發路徑：密碼登入（POST /api/oauth/login）與 passkey 登入（POST /api/oauth/passkey/login）都走這裡，
 * 所以兩者簽出的 authorization code（含 PKCE、可選 dpop_jkt 的 DPoP 綁定）完全同型，後端其餘部分不分辨登入方式（ADR-0016）。
 */
import { D1Adapter } from './oauth-d1-adapter';
import { generateOpaqueToken } from './crypto';
import { parseAllowedScopes } from './oauth-request';

export const LOGIN_CODE_TTL_SEC = 60;
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
export const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

export interface LoginGrant { clientId: string; challenge: string; dpopJkt?: string; scopes: string[] }

/** 只檢查形狀（PKCE、dpop_jkt、scope），不碰資料庫。 */
export function parseGrantShape(body: Record<string, unknown>): { challenge: string; dpopJkt?: string; scope?: string } | null {
  const { code_challenge: challenge, code_challenge_method: method, dpop_jkt: dpopJkt, scope } = body;
  if (method !== 'S256' || typeof challenge !== 'string' || !B64URL_43.test(challenge)) return null;
  if (dpopJkt !== undefined && (typeof dpopJkt !== 'string' || !B64URL_43.test(dpopJkt))) return null;
  if (scope !== undefined && typeof scope !== 'string') return null;
  return { challenge, dpopJkt: dpopJkt as string | undefined, scope };
}

interface ClientRow { client_type: string; status: string; first_party: number; allowed_scopes: string }

/** client 必須是啟用中的第一方 public client，且要求的 scope 都在允許範圍內；否則回 null（呼叫端統一回 400，不洩漏原因）。 */
export async function resolveFirstPartyGrant(
  db: D1Database, clientId: string, shape: { challenge: string; dpopJkt?: string; scope?: string },
): Promise<LoginGrant | null> {
  const client = await db.prepare('SELECT client_type, status, first_party, allowed_scopes FROM client_apps WHERE client_id = ?')
    .bind(clientId).first<ClientRow>();
  if (!client || client.status !== 'active' || client.first_party !== 1 || client.client_type !== 'public') return null;
  const allowed = parseAllowedScopes(client.allowed_scopes);
  const scopes = shape.scope === undefined ? DEFAULT_SCOPES.filter((s) => allowed.includes(s)) : shape.scope.split(/\s+/).filter(Boolean);
  if (scopes.length === 0 || scopes.some((s) => !allowed.includes(s))) return null;
  return { clientId, challenge: shape.challenge, dpopJkt: shape.dpopJkt, scopes };
}

/** 驗證身分成功後簽發 code：60 秒有效、沒有 redirect_uri，可選綁定 DPoP 金鑰。 */
export async function issueLoginCode(db: D1Database, userId: string, grant: LoginGrant): Promise<string> {
  const code = generateOpaqueToken(32);
  await new D1Adapter(db, 'AuthorizationCode').upsert(code, {
    client_id: grant.clientId,
    user_id: userId,
    redirect_uri: null, // 第一方直接換 code，沒有跳轉；兌換時也不可帶 redirect_uri
    scopes: grant.scopes,
    code_challenge: grant.challenge,
    code_challenge_method: 'S256',
    ...(grant.dpopJkt ? { dpop_jkt: grant.dpopJkt } : {}),
  }, LOGIN_CODE_TTL_SEC);
  return code;
}
