/**
 * POST /api/oauth/signup
 * Body: { email, password, privacyConsent: true, displayName?, invitationToken? }
 *
 * Local password account creation。建 user + auth_identities (provider='local')
 * **不發任何登入憑證**（行為變更：舊入口會 issueSession 發 cookie，新 api 沒有 cookie；
 * 註冊後請用 POST /api/oauth/login 換 code）。`email_verified_at` 留 NULL — verify 流程透過
 * /api/oauth/send-verification + /api/oauth/verify endpoints。
 *
 * Security:
 *   - hashPassword（PBKDF2-SHA256 600k iter，src/server/password.ts）
 *   - Email 唯一性靠 users.email UNIQUE constraint（trap UNIQUE error in catch）
 *   - V2-P6 rate limit per-IP（autoplan: 3/h/IP）
 *
 * Error codes:
 *   400 SIGNUP_CONSENT_REQUIRED / SIGNUP_INVALID_EMAIL / SIGNUP_PASSWORD_TOO_SHORT
 *   409 SIGNUP_EMAIL_TAKEN
 *   429 SIGNUP_RATE_LIMITED
 *   500 SYS_INTERNAL
 */
import { AppError, buildRateLimitResponse } from '../../../errors';
import { parseJsonBody } from '../../../lib/utils';
import { hashPassword, MIN_PASSWORD_LEN } from '../../../lib/password';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { tryAcceptInvitation } from '../../../lib/invitation-accept';
import {
  checkRateLimit,
  bumpRateLimit,
  clientIp,
  RATE_LIMITS,
} from '../../../lib/rate-limit';
import { normalizeEmail } from '../../../lib/email-utils';
import type { Env } from '../../../env';
import { maskEmail } from '../../../lib/pii';

interface SignupBody {
  email?: string;
  password?: string;
  displayName?: string;
  /** V2 共編：未註冊者點 invitation link → /signup?invitation=xxx → 註冊時帶來，
   *  註冊成功後自動接受邀請（若 email match）。失敗（過期 / mismatch）不擋 signup。 */
  invitationToken?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 目前生效的個資條款版本。**政策文字有實質變更時必須同步 bump**，
 * 否則無法區分某位使用者同意的是哪一版、也無法判斷誰需要重新同意。
 */
const PRIVACY_POLICY_VERSION = '2026-07-20';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = (await parseJsonBody<SignupBody>(context.request)) ?? {};
  const email = normalizeEmail(body.email ?? '');
  const password = body.password ?? '';
  const displayName = body.displayName?.trim() || null;

  // Validation
  if (!email || !EMAIL_REGEX.test(email)) {
    throw new AppError('SIGNUP_INVALID_EMAIL');
  }
  if (!password || password.length < MIN_PASSWORD_LEN) {
    throw new AppError('SIGNUP_PASSWORD_TOO_SHORT', `密碼至少 ${MIN_PASSWORD_LEN} 字元`);
  }

  // 個資條款同意 —— owner 決策 2026-07-20。
  // 擋在最前面：未同意就不該消耗 rate limit 額度，也不該碰 DB。
  // 只接受明確的 true —— 缺欄位、false、字串 'false' 都算沒同意。
  if ((body as { privacyConsent?: unknown }).privacyConsent !== true) {
    throw new AppError('SIGNUP_CONSENT_REQUIRED');
  }

  // V2-P6 rate limit: per-IP bucket — anti signup-spam.
  // Bump after validation, before DB lookup, so success path also counts (per autoplan: 3/h/IP)
  const ipKey = `signup:${clientIp(context.request)}`;
  const ipCheck = await checkRateLimit(context.env.DB, ipKey, RATE_LIMITS.SIGNUP);
  if (!ipCheck.ok) {
    return buildRateLimitResponse(ipCheck.retryAfter ?? 60, {
      error: { code: 'SIGNUP_RATE_LIMITED', message: '註冊嘗試過多，請稍後再試' },
    });
  }
  await bumpRateLimit(context.env.DB, ipKey, RATE_LIMITS.SIGNUP);

  // Duplicate email check
  const existing = await context.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    await recordAuthEvent(context.env.DB, context.request, {
      eventType: 'signup',
      outcome: 'failure',
      failureReason: 'email_taken',
      metadata: { emailMasked: maskEmail(email) },
    }, context.env);
    throw new AppError('SIGNUP_EMAIL_TAKEN');
  }

  // Hash + INSERT
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch {
    throw new AppError('SIGNUP_PASSWORD_FORMAT');
  }

  const userId = crypto.randomUUID();
  try {
    await context.env.DB
      .prepare(
        `INSERT INTO users (id, email, email_verified_at, display_name,
                            privacy_consent_at, privacy_policy_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      // 同意的時間戳與版本一起寫入 —— 版本讓政策改版後仍能得知某人同意的是哪一版。
      .bind(userId, email, null, displayName, new Date().toISOString(), PRIVACY_POLICY_VERSION)
      .run();
    await context.env.DB
      .prepare(
        `INSERT INTO auth_identities
           (user_id, provider, provider_user_id, password_hash, password_algo, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, 'local', email, passwordHash, 'pbkdf2', new Date().toISOString())
      .run();
  } catch (err) {
    // Race condition：同時兩個 signup 同 email — UNIQUE constraint trap
    const msg = (err as Error).message ?? '';
    if (msg.toUpperCase().includes('UNIQUE')) {
      throw new AppError('SIGNUP_EMAIL_TAKEN', '此 email 已註冊（race condition）');
    }
    throw new AppError('SYS_INTERNAL', `Signup INSERT 失敗：${msg.slice(0, 200)}`);
  }

  // V2 共編：optional invitation token — 註冊成功後嘗試 accept（best-effort，
  // 失敗不擋 signup，errorCode 回傳給 client 顯示提示）
  //
  // **Trust model 設計選擇**：此 invitation accept 路徑會在 user 還沒驗證 email
  // （email_verified_at IS NULL）的情況下加入 trip_permissions。安全考量：
  //   1. inviter 知道 invitee email 並寄出 invitation token
  //   2. invitee 收到 email + 點 link → 隱含證明能接收該 mailbox（possession proof）
  //   3. tryAcceptInvitation 嚴格 check user.email === invitation.invited_email
  //   4. inviter 是 trip owner，已對「邀請誰」負責
  // 這是 GitHub / Notion / Slack 等共編產品的標準 trust model — invitation link
  // 即視為該 email 的所有權證明（一次性、有時限）。後續寄信給該 user 仍會走
  // verification flow（unverified banner 提示），但 trip access 不阻擋。
  let joinedTrip: { id: string; title: string } | null = null;
  let invitationError: string | null = null;
  const rawInviteToken = body.invitationToken?.trim();
  if (rawInviteToken && context.env.SESSION_SECRET) {
    try {
      const result = await tryAcceptInvitation(
        context.env.DB,
        context.env.SESSION_SECRET,
        rawInviteToken,
        { id: userId, email },
      );
      if (result.ok) {
        joinedTrip = { id: result.tripId, title: result.tripTitle };
      } else {
        invitationError = result.code;
      }
    } catch (err) {
      // DB error during invitation accept — don't fail signup
      // eslint-disable-next-line no-console
      console.error('[signup] tryAcceptInvitation failed:', (err as Error).message);
      invitationError = 'INVITATION_ACCEPT_FAILED';
    }
  }

  // 行為變更：舊入口在此 issueSession 發 cookie；新 api 不發任何登入憑證，
  // 回應欄位與舊版相同。
  const response = new Response(
    JSON.stringify({
      ok: true,
      userId,
      email,
      requiresVerification: true,
      joinedTrip,
      invitationError,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );

  // V2-P6 audit log — best-effort, don't fail signup if audit insert fails
  await recordAuthEvent(context.env.DB, context.request, {
    eventType: 'signup',
    outcome: 'success',
    userId,
    metadata: { emailMasked: maskEmail(email), displayName, invitationAccepted: joinedTrip?.id ?? null },
  }, context.env);
  return response;
};
