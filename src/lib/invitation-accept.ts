/**
 * tryAcceptInvitation — V2 共編邀請 accept 共用流程
 *
 * 被以下兩個 endpoint 呼叫：
 *   - POST /api/invitations/accept — 已登入者主動接受
 *   - POST /api/oauth/signup       — 註冊時帶 invitationToken 自動接受
 *
 * 流程：
 *   1. HMAC token → token_hash
 *   2. SELECT trip_invitations WHERE token_hash
 *   3. Check expired / accepted / email match
 *   4. Atomic batch 按邀請角色 INSERT OR IGNORE trip_permissions + UPDATE accepted_at
 *   5. 撈 trip title 給 caller 回應使用
 */
import type { D1Database } from '@cloudflare/workers-types';
import { hashInvitationToken } from './invitation-token';
import { normalizeEmail } from './email-utils';

export type InvitationAcceptResult =
  | { ok: true; tripId: string; tripTitle: string }
  | {
      ok: false;
      code:
        | 'INVITATION_INVALID'
        | 'INVITATION_EXPIRED'
        | 'INVITATION_ACCEPTED'
        | 'INVITATION_EMAIL_MISMATCH';
    };

interface InvitationRow {
  trip_id: string;
  role: string;
  invited_email: string;
  expires_at: string;
  accepted_at: string | null;
}

export async function tryAcceptInvitation(
  db: D1Database,
  secret: string,
  rawToken: string,
  user: { id: string; email: string },
): Promise<InvitationAcceptResult> {
  const tokenHash = await hashInvitationToken(rawToken, secret);

  const invitation = await db
    .prepare(
      `SELECT trip_id, role, invited_email, expires_at, accepted_at
       FROM trip_invitations
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<InvitationRow>();

  if (!invitation) return { ok: false, code: 'INVITATION_INVALID' };
  if (invitation.accepted_at) return { ok: false, code: 'INVITATION_ACCEPTED' };
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    return { ok: false, code: 'INVITATION_EXPIRED' };
  }
  // v2.33.59 round 13: Unicode-correct email compare (NFKC + casefold)
  if (normalizeEmail(user.email) !== normalizeEmail(invitation.invited_email)) {
    return { ok: false, code: 'INVITATION_EMAIL_MISMATCH' };
  }

  // Atomic batch — UPDATE 加 accepted_at IS NULL guard 防 concurrent accept race
  // (last-writer-wins on accepted_at timestamp + replay-after-leak defense)
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO trip_permissions (trip_id, role, user_id)
         VALUES (?, ?, ?)`,
      )
      .bind(invitation.trip_id, invitation.role === 'viewer' ? 'viewer' : 'member', user.id),
    db
      .prepare(
        `UPDATE trip_invitations SET accepted_at = ?, accepted_by = ?
         WHERE token_hash = ? AND accepted_at IS NULL`,
      )
      .bind(new Date().toISOString(), user.id, tokenHash),
  ]);

  const trip = await db
    .prepare('SELECT title FROM trips WHERE id = ?')
    .bind(invitation.trip_id)
    .first<{ title: string }>();

  return { ok: true, tripId: invitation.trip_id, tripTitle: trip?.title ?? '' };
}
