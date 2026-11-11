/**
 * POST /api/account/password — 已登入的「變更密碼」（spec flutter#529）
 * Body: { current_password, new_password }
 *
 * 與 /api/oauth/reset-password 不同：這裡靠「目前密碼」確認本人，不靠信件連結。
 * 成功後：更新密碼 → 撤銷「其他」grant（保留目前這個）→ 寄通知信（best-effort）→ 稽核。
 *
 * 目前密碼錯回 403 而非 401：401 會被 client 當成登入過期而清掉憑證。
 * 限流以使用者為單位：只計失敗，成功清零；沿用 LOGIN 政策（第 6 次錯才上鎖）。
 */
import { requireAccountUser } from '../../../lib/account-user';
import { AppError, buildRateLimitResponse } from '../../../errors';
import { hashPassword, verifyPassword, MIN_PASSWORD_LEN } from '../../../lib/password';
import { bumpRateLimit, checkRateLimit, resetRateLimit, RATE_LIMITS } from '../../../lib/rate-limit';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { recordEmailEvent } from '../../../lib/audit';
import { sendEmail, EmailError } from '../../../lib/email';
import { alertAdminTelegram } from '../../../lib/alert';
import { maskEmail } from '../../../lib/pii';
import { passwordChangedConfirm } from '../../../lib/email-templates';
import { parseJsonBody, rawJson } from '../../../lib/utils';
import { currentGrantId, listUserGrants } from './sessions';
import { enforceStepUp } from '../../../lib/step-up';
import type { Env } from '../../../env';

interface Body {
  current_password?: unknown;
  new_password?: unknown;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  await enforceStepUp(context, user.auth);
  const { env, request } = context;
  const audit = (outcome: 'success' | 'failure', failureReason?: string, metadata?: Record<string, unknown>) =>
    recordAuthEvent(env.DB, request, { eventType: 'password_change', outcome, userId: user.uid, failureReason, metadata }, env);

  const limitKey = `change-password:${user.uid}`;
  const limited = (retryAfter: number) =>
    buildRateLimitResponse(retryAfter, {
      error: { code: 'CHANGE_PASSWORD_RATE_LIMITED', message: '嘗試次數過多，請稍後再試' },
    });

  const check = await checkRateLimit(env.DB, limitKey, RATE_LIMITS.LOGIN);
  if (!check.ok) {
    await audit('failure', 'rate_limited');
    return limited(check.retryAfter ?? 60);
  }

  const body = (await parseJsonBody<Body>(request)) ?? {};
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';

  const identity = await env.DB
    .prepare(`SELECT password_hash FROM auth_identities WHERE user_id = ? AND provider = 'local' AND password_hash IS NOT NULL`)
    .bind(user.uid)
    .first<{ password_hash: string }>();
  if (!identity) {
    await audit('failure', 'no_password');
    throw new AppError('CHANGE_PASSWORD_NO_PASSWORD');
  }

  if (!current || !(await verifyPassword(current, identity.password_hash))) {
    await audit('failure', 'current_invalid');
    const bumped = await bumpRateLimit(env.DB, limitKey, RATE_LIMITS.LOGIN);
    if (!bumped.ok) return limited(bumped.retryAfter ?? 60);
    throw new AppError('CHANGE_PASSWORD_CURRENT_INVALID');
  }

  if (next.length < MIN_PASSWORD_LEN) {
    await audit('failure', 'too_short');
    throw new AppError('CHANGE_PASSWORD_TOO_SHORT', `新密碼至少 ${MIN_PASSWORD_LEN} 字元`);
  }
  if (next === current) {
    await audit('failure', 'same_password');
    throw new AppError('CHANGE_PASSWORD_SAME');
  }

  await env.DB
    .prepare(`UPDATE auth_identities SET password_hash = ?, password_algo = ?, last_used_at = ? WHERE user_id = ? AND provider = 'local'`)
    .bind(await hashPassword(next), 'pbkdf2', new Date().toISOString(), user.uid)
    .run();
  await resetRateLimit(env.DB, limitKey);

  // 撤銷其他裝置：保留目前這個 grant（與「撤銷其他所有連線」同一套做法）。
  // 目前 grant 優先取中介層已解好的 auth.grantId，查表只是後備；沒有 grantId 的舊格式 token 本來就不在
  // listUserGrants 裡，不會被撤銷。
  // best-effort：密碼已換成功，撤銷失敗不能讓使用者以為沒改成功；但「其他裝置沒登出」要留稽核與告警，不能只有 console。
  let revokeFailed = false;
  try {
    const currentSid = user.auth.grantId ?? (await currentGrantId(request, env));
    const adapter = new D1Adapter(env.DB, 'AccessToken');
    for (const g of await listUserGrants(env, user.uid)) {
      if (g.grantId !== currentSid) await adapter.revokeByGrantId(g.grantId);
    }
  } catch (err) {
    revokeFailed = true;
    // eslint-disable-next-line no-console
    console.error('[change-password] revoke other grants failed:', (err as Error).message);
    await alertAdminTelegram(env, `變更密碼後其他裝置未登出（密碼已更新）: ${maskEmail(user.email)}`).catch(() => {});
  }

  // 通知信是事後通知：任何一步失敗（含查 display_name）都不能把已成功的變更變成 500。
  try {
    await sendConfirmation(env, user.email, user.uid);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[change-password] confirmation failed:', (err as Error).message);
  }
  await audit('success', undefined, revokeFailed ? { revoke_failed: true } : undefined);
  return rawJson({ ok: true });
};

/** 通知信：事後通知，失敗只記錄與告警，不影響回應。 */
async function sendConfirmation(env: Env, email: string, userId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first<{ display_name: string | null }>();
  const tpl = passwordChangedConfirm(row?.display_name ?? null);
  try {
    const result = await sendEmail(env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, template: 'change-password-confirm' });
    await recordEmailEvent(env.DB, { template: 'change-password-confirm', recipient: email, status: 'sent', latencyMs: result.elapsed, triggeredBy: email });
  } catch (err) {
    const msg = err instanceof EmailError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
    await recordEmailEvent(env.DB, { template: 'change-password-confirm', recipient: email, status: 'failed', error: msg, triggeredBy: email });
    await alertAdminTelegram(env, `變更密碼通知信寄送失敗（password 已更新）: ${maskEmail(email)} (${msg})`);
  }
}
