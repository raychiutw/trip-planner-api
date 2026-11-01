/**
 * GET /api/invitations — 兩條 query 分支：
 *
 * 1. ?token=xxx  → 公開查詢（未登入也可），返回 invitation preview 給 InvitePage
 *    用。三種失敗 case 共用 410 GONE：INVITATION_INVALID / EXPIRED / ACCEPTED。
 *
 * 2. ?tripId=xxx → 需 auth，trip owner 列出該 trip 所有 pending invitations
 *    給 CollabSheet pending UI 用。回傳 [{ id, invitedEmail, expiresAt, daysRemaining }]，
 *    刻意不包含 token_hash（敏感資料）。
 *
 * 為何 410 不是 404：被邀請者點 link 時收到「已過期」是正常 lifecycle 結尾，semantic 是
 * gone (was here, no longer)，不是 not found。
 */
import { hashInvitationToken } from '../../lib/invitation-token';
import { requireAuth } from '../../lib/permissions';
import { ensureCanManageTripPerms } from './permissions';
import { AppError } from '../../errors';
import type { Env } from '../../env';

interface InvitationRow {
  trip_id: string;
  trip_title: string;
  invited_email: string;
  role: string;
  inviter_display_name: string | null;
  inviter_email: string;
  expires_at: string;
  accepted_at: string | null;
}

interface PendingInvitationRow {
  token_hash: string;
  invited_email: string;
  created_at: string;
  expires_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const rawToken = (url.searchParams.get('token') ?? '').trim();
  const tripId = (url.searchParams.get('tripId') ?? '').trim();

  // Branch 2: list pending invitations for a trip (trip owner only)
  if (tripId) {
    const auth = requireAuth(context);
    await ensureCanManageTripPerms(context, auth, tripId);

    // LIMIT 100：一個 trip 同時 pending 邀請超過 100 已不正常，cap 防 DoS + 大 payload
    const { results } = await context.env.DB
      .prepare(
        `SELECT token_hash, invited_email, created_at, expires_at
         FROM trip_invitations
         WHERE trip_id = ? AND accepted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .bind(tripId)
      .all<PendingInvitationRow>();

    const now = Date.now();
    const items = (results ?? []).map((r) => {
      const expiresMs = new Date(r.expires_at).getTime();
      const daysRemaining = Math.max(0, Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000)));
      const isExpired = expiresMs < now;
      return {
        // 用 token_hash 當 stable identifier 給 frontend revoke/resend reference。
        // 不會洩漏 raw token（hash 即使 leak 也無法用）。
        id: r.token_hash,
        invitedEmail: r.invited_email,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        daysRemaining,
        isExpired,
      };
    });

    return new Response(
      JSON.stringify({ items }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  // Branch 1: public preview by token (existing behaviour)
  if (!rawToken) {
    throw new AppError('INVITATION_TOKEN_MISSING');
  }

  if (!context.env.SESSION_SECRET) {
    throw new AppError('SERVER_MISCONFIG', 'SESSION_SECRET 未設定');
  }

  const tokenHash = await hashInvitationToken(rawToken, context.env.SESSION_SECRET);

  const row = await context.env.DB
    .prepare(
      `SELECT
         ti.trip_id,
         t.title AS trip_title,
         ti.invited_email,
         ti.role,
         u.display_name AS inviter_display_name,
         u.email AS inviter_email,
         ti.expires_at,
         ti.accepted_at
       FROM trip_invitations ti
       JOIN trips t ON t.id = ti.trip_id
       JOIN users u ON u.id = ti.invited_by
       WHERE ti.token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<InvitationRow>();

  if (!row) {
    throw new AppError('INVITATION_INVALID');
  }

  if (row.accepted_at) {
    throw new AppError('INVITATION_ACCEPTED');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('INVITATION_EXPIRED');
  }

  return new Response(
    JSON.stringify({
      tripId: row.trip_id,
      tripTitle: row.trip_title,
      invitedEmail: row.invited_email,
      role: row.role === 'viewer' ? 'viewer' : 'member',
      inviterDisplayName: row.inviter_display_name,
      inviterEmail: row.inviter_email,
      expiresAt: row.expires_at,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
