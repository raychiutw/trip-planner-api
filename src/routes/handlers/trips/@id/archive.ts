/** Owner-only, trip-wide archive state. Archive changes list classification, not access. */
import { assertNotTripRestricted, hasTripScope, requireAuth, TRIP_WRITE_SCOPE } from '../../../../lib/permissions';
import { AppError } from '../../../../errors';
import { json } from '../../../../lib/utils';
import type { Env } from '../../../../env';

async function setArchived(context: Parameters<PagesFunction<Env>>[0], archived: boolean) {
  const auth = requireAuth(context);
  assertNotTripRestricted(auth);
  if (!auth.userId || !hasTripScope(auth, TRIP_WRITE_SCOPE)) throw new AppError('PERM_DENIED');

  const { id } = context.params as { id: string };
  const owner = await context.env.DB.prepare('SELECT owner_user_id FROM trips WHERE id = ?')
    .bind(id).first<{ owner_user_id: string }>();
  if (!owner) throw new AppError('DATA_NOT_FOUND');
  if (owner.owner_user_id !== auth.userId) throw new AppError('PERM_DENIED', '僅行程擁有者可歸檔或取消歸檔');

  const row = await context.env.DB.prepare(
    archived
      ? 'UPDATE trips SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP) WHERE id = ? AND owner_user_id = ? RETURNING archived_at AS archivedAt'
      : 'UPDATE trips SET archived_at = NULL WHERE id = ? AND owner_user_id = ? RETURNING archived_at AS archivedAt',
  ).bind(id, auth.userId).first<{ archivedAt: string | null }>();
  if (!row) throw new AppError('DATA_NOT_FOUND');
  return json(row);
}

export const onRequestPut: PagesFunction<Env> = (context) => setArchived(context, true);
export const onRequestDelete: PagesFunction<Env> = (context) => setArchived(context, false);
