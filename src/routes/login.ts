/**
 * POST /api/oauth/login — 第一方（web／行動端）以帳密直接換 authorization code（IETF first-party apps 的作法）。
 * 不跳轉、不發 cookie；client 拿 code 後走 token endpoint（PKCE，可選 DPoP 綁定）兌換成 token。
 *
 * 安全重點：
 * - 只有 client_apps.first_party=1 的 public client 可用；其他一律同一個 400，而且在驗密碼之前就擋掉
 *   （非第一方 client 不能把這個端點當密碼比對的 oracle）。
 * - 帳號不存在、密碼錯、停權、沒有密碼雜湊：全部同一個 401 LOGIN_INVALID，且一律做一次雜湊運算（防 timing）。
 * - 限流以「IP × 帳號」為單位（錯 10 次鎖 10 分鐘，鎖完再錯 10 次鎖 30 分鐘，之後每輪 30 分鐘）+ 整體 IP 上限（50 次、30 分鐘）：
 *   驗證前先原子地保留一次嘗試；成功時 IP × 帳號清零、整體 IP 退還這一次（計數＝淨失敗）。攻擊者只會鎖到自己的 IP 對該帳號，無法把受害者鎖在外面；
 *   兩種鎖定回應文字相同；不存在的帳號一樣會鎖。已知殘餘：分散式（大量不同 IP）慢速猜單一帳號不會被擋，
 *   需靠密碼強度與 audit 告警。
 * - 強制 PKCE（S256）；code 60 秒有效、沒有 redirect_uri；可選 dpop_jkt 把 code 綁定到金鑰。
 * - 密碼只進雜湊函式：不 log、不寫 audit、不回傳。
 * 錯誤形狀沿用舊入口的巢狀 LOGIN_*（web 登入頁已會處理這些 code）。
 */
import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { AppError, buildRateLimitResponse, errorResponse } from '../errors';
import { recordAuthEvent } from '../lib/auth-audit';
import { generateOpaqueToken } from '../lib/crypto';
import { normalizeEmail } from '../lib/email-utils';
import { sha256Base64Url } from '../lib/crypto';
import { D1Adapter } from '../lib/oauth-d1-adapter';
import { parseAllowedScopes, readJsonObject } from '../lib/oauth-request';
import { verifyPassword } from '../lib/password';
import { recordSecurityEvent } from '../lib/security-events';
import { bumpRateLimit, bumpTieredLock, clientIp, RATE_LIMITS, refundRateLimit, resetRateLimit } from '../lib/rate-limit';

const MAX_PASSWORD_LENGTH = 1024;
const LOGIN_CODE_TTL_SEC = 60;
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

// 帳號不存在時拿來比對的假雜湊（PBKDF2 100k 次，耗時與真的相同）
const TIMING_PROBE_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const invalidInput = () => errorResponse(new AppError('LOGIN_INVALID_INPUT'));
const rateLimited = (retryAfter: number) =>
  buildRateLimitResponse(retryAfter, { error: { code: 'LOGIN_RATE_LIMITED', message: '登入嘗試過多，請稍後再試' } });

interface ClientRow { client_type: string; status: string; first_party: number; allowed_scopes: string }
interface IdentityRow { user_id: string; password_hash: string | null; status: string }

export function registerLoginRoute(app: Hono<AppEnv>): void {
  app.post('/api/oauth/login', async (c) => {
    const { DB } = c.env;
    const request = c.req.raw;

    // 1. 輸入形狀（便宜的檢查先做；任何不合都在碰密碼之前結束）
    const body = await readJsonObject(request);
    if (!body) return invalidInput();
    const { email: rawEmail, password, client_id: clientId, code_challenge: challenge, code_challenge_method: method, dpop_jkt: dpopJkt, scope } = body;
    if (typeof rawEmail !== 'string' || typeof password !== 'string' || typeof clientId !== 'string') return invalidInput();
    if (!password || password.length > MAX_PASSWORD_LENGTH) return invalidInput();
    const email = normalizeEmail(rawEmail);
    if (!email || !clientId) return invalidInput();
    if (method !== 'S256' || typeof challenge !== 'string' || !B64URL_43.test(challenge)) return invalidInput();
    if (dpopJkt !== undefined && (typeof dpopJkt !== 'string' || !B64URL_43.test(dpopJkt))) return invalidInput();
    if (scope !== undefined && typeof scope !== 'string') return invalidInput();

    // 3. client 必須是啟用中的第一方 public client；其他一律同一個 400，不洩漏原因，也不計失敗次數
    const client = await DB.prepare('SELECT client_type, status, first_party, allowed_scopes FROM client_apps WHERE client_id = ?')
      .bind(clientId).first<ClientRow>();
    if (!client || client.status !== 'active' || client.first_party !== 1 || client.client_type !== 'public') return invalidInput();

    const allowed = parseAllowedScopes(client.allowed_scopes);
    const requested = scope === undefined ? DEFAULT_SCOPES.filter((s) => allowed.includes(s)) : scope.split(/\s+/).filter(Boolean);
    if (requested.length === 0 || requested.some((s) => !allowed.includes(s))) return invalidInput();

    // 4. 限流：以「IP × 帳號」為單位、階梯式鎖定（錯 10 次鎖 10 分鐘，鎖完再錯 10 次鎖 30 分鐘）；
    //    攻擊者只會鎖到自己的 IP 對該帳號，本人從別的 IP 不受影響。
    //    另有整體 IP 上限（擋單一 IP 對大量帳號的撞庫）。
    //    兩者都在驗證前先「保留」一次嘗試（bump 是單一語句的原子遞增＋鎖定判斷）：併發猜密碼不會超過上限；
    //    整體 IP 的保留在成功時退還（計數＝淨失敗，穿插成功登入抵銷不了別人的失敗）；
    //    IP × 帳號在成功時清零（只影響自己這組，清不到別人的帳號）。
    //    key 用 email 的雜湊，資料表不留明文 email。
    const ip = clientIp(request);
    const ipKey = `login:${ip}`;
    const pairKey = `login:${ip}:${await sha256Base64Url(email)}`;
    // 先保留「IP × 帳號」；被擋的嘗試不會灌高整體 IP 的計數
    const pairReserved = await bumpTieredLock(DB, pairKey, RATE_LIMITS.LOGIN_PAIR);
    if (!pairReserved.ok) {
      await recordSecurityEvent(c.env, request, { kind: 'rate_limited', reason: 'login_locked', clientId });
      return rateLimited(pairReserved.retryAfter ?? 60);
    }
    const ipReserved = await bumpRateLimit(DB, ipKey, RATE_LIMITS.LOGIN_IP);
    if (!ipReserved.ok) {
      await recordSecurityEvent(c.env, request, { kind: 'rate_limited', reason: 'login_ip_locked', clientId });
      return rateLimited(ipReserved.retryAfter ?? 60);
    }

    // 5. 驗證：一律做一次雜湊運算（真的或假的），再統一判斷
    const identity = await DB.prepare(
      `SELECT ai.user_id, ai.password_hash, u.status
         FROM auth_identities ai JOIN users u ON u.id = ai.user_id
        WHERE ai.provider = 'local' AND ai.provider_user_id = ?`,
    ).bind(email).first<IdentityRow>();
    const passwordOk = await verifyPassword(password, identity?.password_hash ?? TIMING_PROBE_HASH);

    const failureReason = !identity ? 'unknown_email'
      : !identity.password_hash ? 'no_password'
      : !passwordOk ? 'wrong_password'
      : identity.status !== 'active' ? 'account_suspended'
      : null;
    if (failureReason) {
      await recordAuthEvent(DB, request, {
        eventType: 'login', outcome: 'failure', userId: identity?.user_id ?? null, clientId, failureReason, metadata: { email },
      }, c.env);
      return errorResponse(new AppError('LOGIN_INVALID'));
    }

    // 6. 成功：清計數、更新 last_used_at、發 code
    // 退還保留的嘗試（只退自己這一次，不是清零）
    await refundRateLimit(DB, ipKey);
    await resetRateLimit(DB, pairKey); // 本人登入成功：這個 IP × 帳號整組清零（含鎖定階段）
    try {
      await DB.prepare("UPDATE auth_identities SET last_used_at = ? WHERE provider = 'local' AND provider_user_id = ?")
        .bind(new Date().toISOString(), email).run();
    } catch { /* 登入仍成功 */ }

    const userId = identity!.user_id;
    const code = generateOpaqueToken(32);
    await new D1Adapter(DB, 'AuthorizationCode').upsert(code, {
      client_id: clientId,
      user_id: userId,
      redirect_uri: null, // 第一方直接換 code，沒有跳轉；兌換時也不可帶 redirect_uri
      scopes: requested,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(dpopJkt ? { dpop_jkt: dpopJkt } : {}),
    }, LOGIN_CODE_TTL_SEC);

    await recordAuthEvent(DB, request, { eventType: 'login', outcome: 'success', userId, clientId, metadata: { email } }, c.env);
    return c.json({ code, expires_in: LOGIN_CODE_TTL_SEC }, 200, { 'Cache-Control': 'no-store' });
  });
}
