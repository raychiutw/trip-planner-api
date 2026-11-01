/**
 * 邀請流程的 HTTP 邊界測試共用：固定的 SESSION_SECRET（邀請 token 以它做 HMAC）與 seed helper。
 * 邀請列直接寫進真實 D1（等同寄出邀請後的狀態），接受／預覽一律走 createApi。
 */
import { hashInvitationToken } from '../../src/lib/invitation-token';
import { userIdFor } from './helpers';

export const INVITE_SECRET = 'test-session-secret-32-chars-long';

export async function seedInvitation(
  db: D1Database,
  opts: {
    tripId: string;
    token: string;
    invitedEmail: string;
    invitedBy: string; // 邀請者 email
    role?: string;
    expiresAt?: string;
    acceptedAt?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trip_invitations (token_hash, trip_id, invited_email, role, invited_by, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await hashInvitationToken(opts.token, INVITE_SECRET),
      opts.tripId,
      opts.invitedEmail,
      opts.role ?? 'member',
      userIdFor(opts.invitedBy),
      opts.expiresAt ?? '2099-01-01T00:00:00Z',
      opts.acceptedAt ?? null,
    )
    .run();
}
