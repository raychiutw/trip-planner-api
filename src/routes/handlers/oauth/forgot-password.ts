/**
 * POST /api/oauth/forgot-password
 * Body: { email: string }
 *
 * Generate password reset token + store in D1 oauth_models (name='PasswordReset')
 * + send email via Resend (best-effort).
 *
 * Security:
 *   - Always return 200 (no enum leak — 不分 email exists vs not)
 *   - Token cryptographically random (32 bytes base64url)
 *   - 1h TTL (per V2-P3 spec)
 *   - Store via D1Adapter (lazy expire on read)
 *
 * Response shape:
 *   200 { ok: true, message: '若 email 已註冊，重設連結將寄至信箱' }
 *
 * 若 email 確實存在 → token 寫進 D1 + 寄出 reset email。
 * 若 email 不存在 → 沒寫 token，但 response 一樣 (timing safe approximation：
 *   實際上 SQL lookup 仍跑，不再做 token gen 是 minor timing diff，
 *   但 password reset 不像 login 那麼 sensitive — 可接受 minor leak)。
 *
 * Reset URL: {origin}/auth/password/reset?token={token}
 */
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { parseJsonBody, generateOpaqueToken, getPublicOrigin } from '../../../lib/utils';
import {
  checkRateLimit,
  bumpRateLimit,
  clientIp,
  RATE_LIMITS,
} from '../../../lib/rate-limit';
import { sendEmail, EmailError } from '../../../lib/email';
import { passwordReset } from '../../../lib/email-templates';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { recordEmailEvent } from '../../../lib/audit';
import { buildRateLimitResponse } from '../../../errors';
import { alertAdminTelegram } from '../../../lib/alert';
import { maskEmail } from '../../../lib/pii';
import { normalizeEmail } from '../../../lib/email-utils';
import type { Env } from '../../../env';

interface ForgotBody {
  email?: string;
}

const RESET_TOKEN_TTL_SEC = 60 * 60; // 1h per spec

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = (await parseJsonBody<ForgotBody>(context.request)) ?? {};
  const email = normalizeEmail(body.email ?? '');

  // Generic message regardless of outcome (anti-enumeration)
  const genericResponse = new Response(
    JSON.stringify({ ok: true, message: '若 email 已註冊，重設連結將寄至信箱' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  if (!email) return genericResponse;

  // V2-P6 rate limit: per-IP + per-email buckets
  // Per autoplan: 3/h/IP + 3/h/email — defence in depth
  // Bump regardless of email-exists-or-not（response 永遠 generic，attacker 無從分辨）
  const ipKey = `forgot-password:${clientIp(context.request)}`;
  const emailKey = `forgot-password:${email}`;

  const ipCheck = await checkRateLimit(context.env.DB, ipKey, RATE_LIMITS.FORGOT_PASSWORD);
  if (!ipCheck.ok) {
    return buildRateLimitResponse(ipCheck.retryAfter ?? 60, {
      error: { code: 'FORGOT_PASSWORD_RATE_LIMITED', message: '密碼重設請求過多，請稍後再試' },
    });
  }
  const emailCheck = await checkRateLimit(context.env.DB, emailKey, RATE_LIMITS.FORGOT_PASSWORD);
  if (!emailCheck.ok) {
    // v2.33.42 security audit: 統一 wording — 之前「此 email 重設請求過多」
    // 確認 email 存在於系統（其他無法區分情境都走匿名 200 generic message），
    // 給 attacker user-enumeration oracle。
    return buildRateLimitResponse(emailCheck.retryAfter ?? 60, {
      error: { code: 'FORGOT_PASSWORD_RATE_LIMITED', message: '密碼重設請求過多，請稍後再試' },
    });
  }

  // Bump both buckets — every valid request counts (anti-enumeration: response is generic anyway)
  await bumpRateLimit(context.env.DB, ipKey, RATE_LIMITS.FORGOT_PASSWORD);
  await bumpRateLimit(context.env.DB, emailKey, RATE_LIMITS.FORGOT_PASSWORD);

  // Check if user exists with local provider
  const user = await context.env.DB
    .prepare(
      `SELECT u.id AS user_id, u.display_name FROM users u
       JOIN auth_identities ai ON ai.user_id = u.id
       WHERE u.email = ? AND ai.provider = 'local' LIMIT 1`,
    )
    .bind(email)
    .first<{ user_id: string; display_name: string | null }>();

  if (!user) {
    // Don't generate token, but return same generic response
    return genericResponse;
  }

  // Generate + store reset token
  const token = generateOpaqueToken();
  const adapter = new D1Adapter(context.env.DB, 'PasswordReset');
  await adapter.upsert(
    token,
    { userId: user.user_id, email, createdAt: Date.now(), used: false },
    RESET_TOKEN_TTL_SEC,
  );

  // v2.33.59 round 13: 改用 getPublicOrigin 避免信 Host header
  const origin = getPublicOrigin(context.env, context.request);
  const resetUrl = `${origin}/auth/password/reset?token=${encodeURIComponent(token)}`;
  const tpl = passwordReset(resetUrl, user.display_name);

  // v2.33.59 round 13: 改 background send via waitUntil — anti-enumeration
  // (known vs unknown email 同 timing ~20ms)。失敗 silent (audit + telegram alert)，
  // user 看不到失敗訊息但 ops 仍可 monitor。
  // 之前 2026-05-02 Q7 抉擇是「誠實回 500，捨棄 anti-enum (私人圈)」，本 round
  // 因 security audit 找到 1000ms+ timing oracle 反向修正。
  const userId = user.user_id;
  context.waitUntil((async () => {
    try {
      const result = await sendEmail(context.env, {
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        template: 'forgot-password',
      });
      await recordEmailEvent(context.env.DB, {
        template: 'forgot-password',
        recipient: email,
        status: 'sent',
        latencyMs: result.elapsed,
      });
      await recordAuthEvent(context.env.DB, context.request, {
        eventType: 'password_reset_request',
        outcome: 'success',
        userId,
        // 不存明文 email —— userId 已能定位帳號，遮罩版僅供人工比對。
        metadata: { emailMasked: maskEmail(email) },
      }, context.env);
    } catch (err) {
      const msg = err instanceof EmailError
        ? `${err.status} ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      await recordEmailEvent(context.env.DB, {
        template: 'forgot-password',
        recipient: email,
        status: 'failed',
        error: msg,
      });
      await recordAuthEvent(context.env.DB, context.request, {
        eventType: 'password_reset_request',
        outcome: 'failure',
        userId,
        // 稽核 metadata 不存明文 email（userId 已能定位，遮罩版供人工比對）。
        metadata: { emailMasked: maskEmail(email), reason: 'email_send_failed', error: msg },
      }, context.env);
      await alertAdminTelegram(
        context.env,
        `重設密碼信寄送失敗: ${maskEmail(email)} (${msg})`,
      );
    }
  })());
  return genericResponse;
};
