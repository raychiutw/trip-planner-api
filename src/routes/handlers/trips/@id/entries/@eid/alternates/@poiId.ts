/**
 * DELETE /api/trips/:id/entries/:eid/alternates/:poiId — remove alternate POI
 *
 * Master 不能透過此 endpoint 移除（會 throw DATA_VALIDATION）；
 * 刪 master = 刪整個 entry，走 DELETE /api/trips/:id/entries/:eid。
 *
 * Query string:
 *   - entryPoisVersion?: string — OCC token from prior GET; mismatch → 409 STALE_ENTRY.
 *     (DELETE has no body per HTTP semantics, so version travels via query.)
 *
 * POI 不在此 entry → 404 POI_NOT_ALTERNATE。
 */
import { logAudit } from '../../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../../lib/permissions';
import { AppError } from '../../../../../../../errors';
import { removeAlternate } from '../../../../../../../lib/entry-pois';
import { json, parseIntParam } from '../../../../../../../lib/utils';
import type { Env } from '../../../../../../../env';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, eid: eidStr, poiId: poiIdStr } = context.params as {
    id: string;
    eid: string;
    poiId: string;
  };
  const eid = parseIntParam(eidStr);
  const poiId = parseIntParam(poiIdStr);
  if (!eid) throw new AppError('DATA_VALIDATION', 'entry ID 格式錯誤');
  if (!poiId) throw new AppError('DATA_VALIDATION', 'poi ID 格式錯誤');
  const db = context.env.DB;

  const [canWrite, belongsToTrip] = await Promise.all([
    hasWritePermission(db, auth, id),
    verifyEntryBelongsToTrip(db, eid, id),
  ]);
  if (!canWrite) throw new AppError('PERM_DENIED');
  if (!belongsToTrip) throw new AppError('DATA_NOT_FOUND');

  // OCC token via query string (round 4 fix F3 — DELETE has no body)
  const url = new URL(context.request.url);
  const expectedVersion = url.searchParams.get('entryPoisVersion') ?? undefined;

  const result = await removeAlternate(db, eid, poiId, expectedVersion);

  // Audit log (round 4 fix S1)
  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entry_pois',
    recordId: eid,
    action: 'delete',
    changedBy: auth.email,
    diffJson: JSON.stringify({ alt_removed: poiId }),
  });

  return json({
    entryId: eid,
    poiId,
    entryPoisVersion: result.version,
  });
};
