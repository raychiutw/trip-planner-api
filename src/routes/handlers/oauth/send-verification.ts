/**
 * POST /api/oauth/send-verification
 * Body: { email: string }
 *
 * Generate email verification token + send verify link via Resend (best-effort).
 *
 * Anti-enumeration：response 永遠 generic 200。Email 不存在或已驗證的 case 都
 * 不洩漏給 caller — 只有真正 unverified user 才產 token。
 *
 * Flow:
 *   1. lowercase email
 *   2. SELECT users WHERE email = ? AND email_verified_at IS NULL
 *   3. 若 found：產 token + D1Adapter upsert (24h TTL per V2-P2 spec) + send email
 *   4. 若 not found / already verified：silently no-op
 *   5. Always return 200 generic
 *
 * Verify link: {origin}/api/oauth/verify?token={token}
 */
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { parseJsonBody, generateOpaqueToken, getPublicOrigin } from '../../../lib/utils';
import { bumpRateLimit, checkRateLimit, clientIp, RATE_LIMITS } from '../../../lib/rate-limit';
import { sendEmail, EmailError } from '../../../lib/email';
import { emailVerification } from '../../../lib/email-templates';
import { recordEmailEvent } from '../../../lib/audit';
import { alertAdminTelegram } from '../../../lib/alert';
import { maskEmail } from '../../../lib/pii';
import { normalizeEmail } from '../../../lib/email-utils';
import { buildRateLimitResponse } from '../../../errors';
import type { Env } from '../../../env';

interface SendVerificationBody {
  email?: string;
}

const EMAIL_VERIFY_TOKEN_TTL_SEC = 24 * 60 * 60; // 24h per V2-P2 spec

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // v2.33.52 cleanup (round 5d defer): per-IP + per-email rate limit。Anonymous
  // POST 可 trigger Resend email send (quota / cost drain)。重用 FORGOT_PASSWORD
  // policy (3/h window, 1h lockout)。
  const ipKey = `send-verification:${clientIp(context.request)}`;
  const ipCheck = await checkRateLimit(context.env.DB, ipKey, RATE_LIMITS.FORGOT_PASSWORD);
  if (!ipCheck.ok) {
    return buildRateLimitResponse(ipCheck.retryAfter ?? 60, {
      error: { code: 'VERIFY_RATE_LIMITED', message: '驗證信寄送過多，請稍後再試' },
    });
  }

  const body = (await parseJsonBody<SendVerificationBody>(context.request)) ?? {};
  const email = normalizeEmail(body.email ?? '');

  const genericResponse = new Response(
    JSON.stringify({ ok: true, message: '若帳號需要驗證，驗證信會寄至信箱' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  if (!email) return genericResponse;

  // Bump per-email (anti-enumeration: 統一 message 不 leak existence)
  const emailKey = `send-verification:${email}`;
  const emailCheck = await checkRateLimit(context.env.DB, emailKey, RATE_LIMITS.FORGOT_PASSWORD);
  if (!emailCheck.ok) {
    return buildRateLimitResponse(emailCheck.retryAfter ?? 60, {
      error: { code: 'VERIFY_RATE_LIMITED', message: '驗證信寄送過多，請稍後再試' },
    });
  }
  await bumpRateLimit(context.env.DB, ipKey, RATE_LIMITS.FORGOT_PASSWORD);
  await bumpRateLimit(context.env.DB, emailKey, RATE_LIMITS.FORGOT_PASSWORD);

  // Look up unverified user (joined to display_name for email greeting)
  const user = await context.env.DB
    .prepare(
      `SELECT id, display_name
       FROM users
       WHERE email = ? AND email_verified_at IS NULL LIMIT 1`,
    )
    .bind(email)
    .first<{ id: string; display_name: string | null }>();

  if (!user) {
    // Either email doesn't exist or already verified — silent no-op
    return genericResponse;
  }

  // Generate + store token
  const token = generateOpaqueToken();
  const adapter = new D1Adapter(context.env.DB, 'EmailVerification');
  await adapter.upsert(
    token,
    { userId: user.id, email, createdAt: Date.now() },
    EMAIL_VERIFY_TOKEN_TTL_SEC,
  );

  // 2026-05-02 cutover: sync send via mac mini tunnel + audit + telegram alert.
  // Q7: 失敗時誠實回 500「寄送失敗」(no anti-enumeration exception even though
  // existence vs failure is partially observable to attacker — UX > 安全 trade-off).
  // Token 仍存 D1，user 之後可重寄。
  // v2.33.59 round 13: 改用 getPublicOrigin 避免信 Host header
  const origin = getPublicOrigin(context.env, context.request);
  // v2.33.59 round 13 H2: email link 改指 SPA landing page (auto-POST verify)。
  // /api/oauth/verify GET path 保留 backward compat 給已寄出的 email。
  const verifyUrl = `${origin}/auth/verify-email?token=${encodeURIComponent(token)}`;
  const tpl = emailVerification(verifyUrl, user.display_name);

  // v2.33.59 round 13: 同 forgot-password — 改 background send via waitUntil
  // anti-enum (known vs unknown email 同 timing ~20ms response)。失敗 silent
  // (audit + telegram alert)，user 看不到 specific 失敗訊息但 ops 仍 monitor。
  context.waitUntil((async () => {
    try {
      const result = await sendEmail(context.env, {
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        template: 'verification',
      });
      await recordEmailEvent(context.env.DB, {
        template: 'verification',
        recipient: email,
        status: 'sent',
        latencyMs: result.elapsed,
      });
    } catch (err) {
      const msg = err instanceof EmailError
        ? `${err.status} ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      await recordEmailEvent(context.env.DB, {
        template: 'verification',
        recipient: email,
        status: 'failed',
        error: msg,
      });
      await alertAdminTelegram(
        context.env,
        `驗證信寄送失敗: ${maskEmail(email)} (${msg})`,
      );
    }
  })());
  return genericResponse;
};
