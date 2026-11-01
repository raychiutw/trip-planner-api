/**
 * POST /api/oauth/reset-password
 * Body: { token: string, password: string }
 *
 * Verify reset token + update password_hash + consume token + revoke all
 * existing sessions for the user (force re-login on the new password).
 *
 * Flow:
 *   1. Validate token + password format
 *   2. D1Adapter find token (oauth_models name='PasswordReset')
 *   3. If not found / expired / used → 400 RESET_TOKEN_INVALID
 *   4. hashPassword(new password) → UPDATE auth_identities WHERE user_id = ?
 *   5. consume token (one-time-use; row kept until expires_at so re-clicks see 'used')
 *   6. 撤銷該使用者所有 session_devices 與 access/refresh token，讓持有舊憑證者立即失效。
 *   7. Return 200 (caller redirect to /login)
 *
 * 不 issue session 自動：force user 用新密碼 explicit login，verify 他記得新密碼。
 */
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { AppError, buildRateLimitResponse } from '../../../errors';
import { hashPassword, MIN_PASSWORD_LEN } from '../../../lib/password';
import { parseJsonBody } from '../../../lib/utils';
import { bumpRateLimit, checkRateLimit, clientIp, RATE_LIMITS } from '../../../lib/rate-limit';
import { sendEmail, EmailError } from '../../../lib/email';
import { recordEmailEvent } from '../../../lib/audit';
import { alertAdminTelegram } from '../../../lib/alert';
import { maskEmail } from '../../../lib/pii';
import { passwordChangedConfirm } from '../../../lib/email-templates';
import { recordAuthEvent } from '../../../lib/auth-audit';
import type { Env } from '../../../env';

interface ResetBody {
  token?: string;
  password?: string;
}

interface ResetTokenPayload {
  userId: string;
  email: string;
  createdAt: number;
  /** Set on consume (matches D1Adapter.consume()'s field name). Re-clicks see this. */
  consumed?: number;
  /** Legacy field — older code wrote `used` instead of `consumed`. Read both. */
  used?: boolean;
  [key: string]: unknown;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // v2.33.52 cleanup (round 5d defer): per-IP rate limit。Token entropy 256-bit
  // brute force 已不可行，但 scanner / credential stuffing 仍會 burn D1 work +
  // log noise。重用 LOGIN policy (5/15min window, 30min lockout)。
  const ipKey = `reset-password:${clientIp(context.request)}`;
  const ipCheck = await checkRateLimit(context.env.DB, ipKey, RATE_LIMITS.LOGIN);
  if (!ipCheck.ok) {
    return buildRateLimitResponse(ipCheck.retryAfter ?? 60, {
      error: { code: 'RESET_RATE_LIMITED', message: '密碼重設嘗試過多，請稍後再試' },
    });
  }

  const body = (await parseJsonBody<ResetBody>(context.request)) ?? {};
  const token = (body.token ?? '').trim();
  const password = body.password ?? '';

  if (!token) {
    throw new AppError('RESET_TOKEN_MISSING');
  }
  if (!password || password.length < MIN_PASSWORD_LEN) {
    throw new AppError('RESET_PASSWORD_TOO_SHORT', `密碼至少 ${MIN_PASSWORD_LEN} 字元`);
  }

  // Bump 計數（每次正常呼叫都 +1，正常 user 通常 1 次即成功）。
  await bumpRateLimit(context.env.DB, ipKey, RATE_LIMITS.LOGIN);

  const adapter = new D1Adapter(context.env.DB, 'PasswordReset');
  const tokenRow = (await adapter.find(token)) as ResetTokenPayload | undefined;

  if (!tokenRow) {
    await recordAuthEvent(context.env.DB, context.request, {
      eventType: 'password_reset_complete',
      outcome: 'failure',
      failureReason: 'invalid_token',
    }, context.env);
    throw new AppError('RESET_TOKEN_INVALID', '重設連結已過期或無效');
  }

  // One-time use safeguard (handle both legacy `used:true` rows and new `consumed:<ts>`)
  if (tokenRow.consumed || tokenRow.used) {
    await recordAuthEvent(context.env.DB, context.request, {
      eventType: 'password_reset_complete',
      outcome: 'failure',
      userId: tokenRow.userId,
      failureReason: 'token_used',
    }, context.env);
    throw new AppError('RESET_TOKEN_INVALID', '重設連結已使用，請重新申請');
  }

  // Hash + UPDATE
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch {
    throw new AppError('RESET_PASSWORD_FORMAT');
  }

  await context.env.DB
    .prepare(
      `UPDATE auth_identities
       SET password_hash = ?, password_algo = ?, last_used_at = ?
       WHERE user_id = ? AND provider = 'local'`,
    )
    .bind(passwordHash, 'pbkdf2', new Date().toISOString(), tokenRow.userId)
    .run();

  // Mark token consumed (kept until expires_at so re-clicks return 'used')
  // v2.33.58 round 12 C4: consume 改 boolean 返值，這裡無 race detect 需求
  // (重複 click 走 .consumed 早期擋的 path)。void 忽略。
  void (await adapter.consume(token));

  // Revoke ALL existing credentials for this user — security boundary: 持有舊憑證
  // （被竊的 session / bearer token）的人在使用者重設密碼的瞬間失去存取權。
  // 新 api 沒有 cookie session：除了舊的 session_devices 紀錄，也撤銷該使用者所有
  // AccessToken / RefreshToken（oauth_models，$.user_id）。best-effort 與舊版一致。
  try {
    await context.env.DB
      .prepare(
        `UPDATE session_devices SET revoked_at = datetime('now')
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .bind(tokenRow.userId)
      .run();
    await context.env.DB
      .prepare(
        `DELETE FROM oauth_models
         WHERE name IN ('AccessToken', 'RefreshToken')
           AND json_extract(payload, '$.user_id') = ?`,
      )
      .bind(tokenRow.userId)
      .run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reset-password] revoke credentials failed:', (err as Error).message);
  }

  // Send confirmation email — best-effort（密碼已更新，不擋 user 的 200 response）。
  // Q7 例外：confirmation 是「事後通知」非「primary deliverable」，回 500 會讓
  // user 誤以為密碼沒改成功 → 重複嘗試。改成 best-effort + audit + telegram alert
  // 給 admin observable 即可。
  const userRow = await context.env.DB
    .prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(tokenRow.userId)
    .first<{ display_name: string | null }>();
  const tpl = passwordChangedConfirm(userRow?.display_name ?? null);
  try {
    const result = await sendEmail(context.env, {
      to: tokenRow.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      template: 'reset-password-confirm',
    });
    await recordEmailEvent(context.env.DB, {
      template: 'reset-password-confirm',
      recipient: tokenRow.email,
      status: 'sent',
      latencyMs: result.elapsed,
      triggeredBy: tokenRow.email,
    });
  } catch (err) {
    const msg = err instanceof EmailError
      ? `${err.status} ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    await recordEmailEvent(context.env.DB, {
      template: 'reset-password-confirm',
      recipient: tokenRow.email,
      status: 'failed',
      error: msg,
      triggeredBy: tokenRow.email,
    });
    await alertAdminTelegram(
      context.env,
      `密碼重設確認信寄送失敗（password 已更新）: ${maskEmail(tokenRow.email)} (${msg})`,
    );
  }

  await recordAuthEvent(context.env.DB, context.request, {
    eventType: 'password_reset_complete',
    outcome: 'success',
    userId: tokenRow.userId,
    metadata: { email: tokenRow.email },
  }, context.env);

  return new Response(
    JSON.stringify({ ok: true, message: '密碼已更新，請用新密碼登入' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
