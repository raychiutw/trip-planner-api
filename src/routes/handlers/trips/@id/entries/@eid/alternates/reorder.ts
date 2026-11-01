/**
 * PATCH /api/trips/:id/entries/:eid/alternates/reorder — reorder alternates
 *
 * Body:
 *   - order: number[] — poiId array，新順序（不含 master）。長度必須等於當前
 *     alternates count，內容必須完全等同當前 alternates set（不增不減）。
 *   - entryPoisVersion?: string — OCC token from prior GET; mismatch → 409 STALE_ENTRY
 *
 * Server 從 sort_order=2 起依序賦值 (2, 3, 4, ...)。Master sort_order=1 不動。
 *
 * 違反 (length / set mismatch / duplicates) → 422 INVALID_ORDER。
 */
import { logAudit } from '../../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../../lib/permissions';
import { AppError } from '../../../../../../../errors';
import { reorderAlternates } from '../../../../../../../lib/entry-pois';
import { json, parseJsonBody, parseIntParam } from '../../../../../../../lib/utils';
import type { Env } from '../../../../../../../env';

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, eid: eidStr } = context.params as { id: string; eid: string };
  const eid = parseIntParam(eidStr);
  if (!eid) throw new AppError('DATA_VALIDATION', 'entry ID 格式錯誤');
  const db = context.env.DB;

  const [canWrite, belongsToTrip] = await Promise.all([
    hasWritePermission(db, auth, id),
    verifyEntryBelongsToTrip(db, eid, id),
  ]);
  if (!canWrite) throw new AppError('PERM_DENIED');
  if (!belongsToTrip) throw new AppError('DATA_NOT_FOUND');

  const body = await parseJsonBody<{ order?: unknown; entryPoisVersion?: string }>(context.request);
  if (!Array.isArray(body.order)) {
    throw new AppError('INVALID_ORDER', 'order 必須是 array');
  }
  const orderedPoiIds = body.order.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new AppError('INVALID_ORDER', 'order 內所有元素必須是 positive integer');
    }
    return v;
  });

  const result = await reorderAlternates(db, eid, orderedPoiIds, body.entryPoisVersion);

  // Audit log (round 4 fix S1)
  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entry_pois',
    recordId: eid,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({ reordered: orderedPoiIds }),
  });

  return json({
    entryId: eid,
    order: orderedPoiIds,
    entryPoisVersion: result.version,
  });
};
