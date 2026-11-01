/**
 * POST /api/invitations/revoke — 撤銷 pending invitation
 *
 * Body: { tripId: string, email: string }
 *
 * Auth: trip owner only（同 ensureCanManageTripPerms 規則；Phase 3 移除全域 admin）。
 *
 * 為何 POST + body 而非 DELETE /:id：trip_invitations PK 是 token_hash（base64url
 * 32 bytes，URL 內醜且暴露 hash）。用 trip_id + invited_email 複合鍵在 URL 內也
 * 麻煩（email URL-encoding）。POST + body 是 pragmatic 取捨。
 *
 * 只刪 pending（accepted_at IS NULL）— 已接受的 invitation 不能 revoke（已成
 * trip_permissions row），那要走 DELETE /api/permissions/:id。
 */
import { ensureCanManageTripPerms } from '../permissions';
import { requireAuth } from '../../../lib/permissions';
import { logAudit } from '../../../lib/audit';
import {  parseJsonBody } from '../../../lib/utils';
import { normalizeEmail } from '../../../lib/email-utils';
import type { Env } from '../../../env';

interface RevokeBody {
  tripId?: string;
  email?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const body = (await parseJsonBody<RevokeBody>(context.request)) ?? {};
  const tripId = body.tripId?.trim();
  const email = body.email ? normalizeEmail(body.email) : undefined;

  if (!tripId || !email) {
    return new Response(
      JSON.stringify({ error: { code: 'INVITATION_REVOKE_VALIDATION', message: '缺少 tripId 或 email' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  await ensureCanManageTripPerms(context, auth, tripId);

  const result = await context.env.DB
    .prepare(
      `DELETE FROM trip_invitations
       WHERE trip_id = ? AND invited_email = ? AND accepted_at IS NULL`,
    )
    .bind(tripId, email)
    .run();

  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    return new Response(
      JSON.stringify({ error: { code: 'INVITATION_NOT_FOUND', message: '找不到 pending invitation（可能已撤銷或已接受）' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  await logAudit(context.env.DB, {
    tripId,
    tableName: 'trip_invitations',
    recordId: null,
    action: 'delete',
    changedBy: auth.email,
    diffJson: JSON.stringify({ event: 'revoked', invited_email: email }),
  });

  return new Response(
    JSON.stringify({ ok: true, revoked: changes }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
