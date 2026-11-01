/**
 * POST /api/admin/maps-lock — Manually engage Google Maps kill switch.
 *
 * Auth: service-token ops:maps scope.
 * Body (optional): { "reason": "string" }
 * Response: { "locked": true, "reason": string, "locked_at": ISO timestamp }
 */

import { requireScope } from '../../../lib/permissions';
import { setLockState } from '../../../lib/maps-lock';
import { logAudit } from '../../../lib/audit';
import type { Env } from '../../../env';

interface LockBody {
  reason?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireScope(context, 'ops:maps');
  const body = (await context.request.json().catch(() => ({}))) as LockBody;
  const reason = body.reason || 'manual lock by admin';

  const { at } = await setLockState(context.env.DB, true, { actor: auth.email, reason });

  await logAudit(context.env.DB, {
    tripId: '',
    tableName: 'app_settings',
    recordId: null,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({ key: 'google_maps_locked', from: 'false', to: 'true', reason }),
  });

  return new Response(
    JSON.stringify({ locked: true, reason, locked_at: at }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
