/**
 * POST /api/oauth/login — 第一方（web／行動端）以帳密直接換 authorization code（IETF first-party apps 的作法）。
 * 不跳轉、不發 cookie；client 拿 code 後走 token endpoint（PKCE，可選 DPoP 綁定）兌換成 token。
 *
 * 安全重點：
 * - 只有 client_apps.first_party=1 的 public client 可用；其他一律同一個 400，而且在驗密碼之前就擋掉
 *   （非第一方 client 不能把這個端點當密碼比對的 oracle）。
 * - 帳號不存在、密碼錯、停權、沒有密碼雜湊：全部同一個 401 LOGIN_INVALID，且一律做一次雜湊運算（防 timing）。
 * - per-IP 與 per-email 限流（5 次／15 分鐘，鎖 30 分鐘）；兩種鎖定回應文字相同；不存在的帳號一樣會鎖。
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
import { D1Adapter } from '../lib/oauth-d1-adapter';
import { verifyPassword } from '../lib/password';
import { bumpRateLimit, checkRateLimit, clientIp, RATE_LIMITS, resetRateLimit } from '../lib/rate-limit';

const MAX_BODY_BYTES = 16 * 1024;
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseAllowedScopes(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return []; // 壞掉 → 空白名單（拒絕）
  }
}

export function registerLoginRoute(app: Hono<AppEnv>): void {
  app.post('/api/oauth/login', async (c) => {
    const { DB } = c.env;
    const request = c.req.raw;

    // 1. 輸入形狀（便宜的檢查先做；任何不合都在碰密碼之前結束）
    const body = await readJson(request);
    if (!body) return invalidInput();
    const { email: rawEmail, password, client_id: clientId, code_challenge: challenge, code_challenge_method: method, dpop_jkt: dpopJkt, scope } = body;
    if (typeof rawEmail !== 'string' || typeof password !== 'string' || typeof clientId !== 'string') return invalidInput();
    if (!password || password.length > MAX_PASSWORD_LENGTH) return invalidInput();
    const email = normalizeEmail(rawEmail);
    if (!email || !clientId) return invalidInput();
    if (method !== 'S256' || typeof challenge !== 'string' || !B64URL_43.test(challenge)) return invalidInput();
    if (dpopJkt !== undefined && (typeof dpopJkt !== 'string' || !B64URL_43.test(dpopJkt))) return invalidInput();
    if (scope !== undefined && typeof scope !== 'string') return invalidInput();

    // 2. 已被鎖定的 IP 直接擋（只讀，不寫）
    const ipKey = `login:${clientIp(request)}`;
    const ipCheck = await checkRateLimit(DB, ipKey, RATE_LIMITS.LOGIN);
    if (!ipCheck.ok) return rateLimited(ipCheck.retryAfter ?? 60);

    // 3. client 必須是啟用中的第一方 public client；其他一律同一個 400，不洩漏原因，也不計失敗次數
    const client = await DB.prepare('SELECT client_type, status, first_party, allowed_scopes FROM client_apps WHERE client_id = ?')
      .bind(clientId).first<ClientRow>();
    if (!client || client.status !== 'active' || client.first_party !== 1 || client.client_type !== 'public') return invalidInput();

    const allowed = parseAllowedScopes(client.allowed_scopes);
    const requested = scope === undefined ? DEFAULT_SCOPES.filter((s) => allowed.includes(s)) : scope.split(/\s+/).filter(Boolean);
    if (requested.length === 0 || requested.some((s) => !allowed.includes(s))) return invalidInput();

    // 4. per-email 鎖定
    const emailKey = `login:${email}`;
    const emailCheck = await checkRateLimit(DB, emailKey, RATE_LIMITS.LOGIN);
    if (!emailCheck.ok) return rateLimited(emailCheck.retryAfter ?? 60);

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
      await bumpRateLimit(DB, ipKey, RATE_LIMITS.LOGIN);
      await bumpRateLimit(DB, emailKey, RATE_LIMITS.LOGIN);
      await recordAuthEvent(DB, request, {
        eventType: 'login', outcome: 'failure', userId: identity?.user_id ?? null, clientId, failureReason, metadata: { email },
      }, c.env);
      return errorResponse(new AppError('LOGIN_INVALID'));
    }

    // 6. 成功：清計數、更新 last_used_at、發 code
    await resetRateLimit(DB, ipKey);
    await resetRateLimit(DB, emailKey);
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
