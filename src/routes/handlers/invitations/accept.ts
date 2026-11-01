/**
 * POST /api/invitations/accept — V2 共編邀請接受
 *
 * Body: { token: string }
 *
 * Auth required（requireAccountUser：第一方 client 的 user-bound bearer）。流程：
 *   1. requireSessionUser → uid
 *   2. SELECT users → user.email
 *   3. tryAcceptInvitation helper（HMAC + lookup + email match + atomic batch）
 *   4. Audit log
 *   5. Return { ok, tripId, tripTitle }
 *
 * 共用 helper src/server/invitation-accept.ts，確保 signup endpoint 跟此 endpoint
 * 同邏輯（不會 drift）。
 */
import { AppError } from '../../../errors';
import { requireAccountUser } from '../../../lib/account-user';
import { tryAcceptInvitation } from '../../../lib/invitation-accept';
import { normalizeEmail } from '../../../lib/email-utils';
import { parseJsonBody } from '../../../lib/utils';
import { logAudit } from '../../../lib/audit';
import type { Env } from '../../../env';

interface AcceptBody {
  token?: string;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVITATION_INVALID: 410,
  INVITATION_EXPIRED: 410,
  INVITATION_ACCEPTED: 410,
  INVITATION_EMAIL_MISMATCH: 403,
};

const MESSAGE_BY_CODE: Record<string, string> = {
  INVITATION_INVALID: '邀請連結無效',
  INVITATION_EXPIRED: '邀請已過期',
  INVITATION_ACCEPTED: '此邀請已接受過',
  INVITATION_EMAIL_MISMATCH: '此邀請不屬於你的帳號',
};

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // 1. Auth
  let session;
  try {
    session = await requireAccountUser(context);
  } catch (err) {
    if (err instanceof AppError && err.code === 'AUTH_REQUIRED') {
      return errorResponse('AUTH_REQUIRED', '請先登入', 401);
    }
    throw err;
  }

  // 2. Body
  const body = (await parseJsonBody<AcceptBody>(context.request)) ?? {};
  const rawToken = (body.token ?? '').trim();
  if (!rawToken) {
    return errorResponse('INVITATION_TOKEN_MISSING', '缺少 token', 400);
  }

  if (!context.env.SESSION_SECRET) {
    return errorResponse('SERVER_MISCONFIG', 'SESSION_SECRET 未設定', 500);
  }

  // 3. User email
  const userRow = await context.env.DB
    .prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(session.uid)
    .first<{ id: string; email: string }>();

  if (!userRow) {
    return errorResponse('AUTH_INVALID', '使用者不存在', 401);
  }

  // 4. Accept (共用 helper)
  const result = await tryAcceptInvitation(
    context.env.DB,
    context.env.SESSION_SECRET,
    rawToken,
    userRow,
  );

  if (!result.ok) {
    return errorResponse(
      result.code,
      MESSAGE_BY_CODE[result.code] ?? '邀請處理失敗',
      STATUS_BY_CODE[result.code] ?? 410,
    );
  }

  // 5. Audit log (best-effort)
  await logAudit(context.env.DB, {
    tripId: result.tripId,
    tableName: 'trip_invitations',
    recordId: null,
    action: 'update',
    changedBy: userRow.email,
    diffJson: JSON.stringify({ event: 'accepted', invited_email: normalizeEmail(userRow.email) }),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      tripId: result.tripId,
      tripTitle: result.tripTitle,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
