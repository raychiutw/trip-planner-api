/**
 * POST /api/trips/:id/entries/:eid/alternates — 加 alternate POI
 *
 * Body:
 *   - poiId: number — alternate POI id（不可是現有 master 或已存在 alternate）
 *   - 或 { name, lat, lng, type?, category?, address?, rating?, country?, source? }
 *     — 直接從搜尋結果 find-or-create 後加入 alternate
 *   - entryPoisVersion?: string — OCC token from prior GET; mismatch → 409 STALE_ENTRY
 *
 * Server 自動 assign sort_order = max + 1。
 * UNIQUE (entry_id, poi_id) 違反 → 409 DUPLICATE_POI。
 * Entry 無 master → 400 MISSING_MASTER（先設 master 再加 alternate）。
 */
import { logAudit } from '../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { addAlternate } from '../../../../../../lib/entry-pois';
import { findOrCreatePoi, normalizeFindOrCreatePoiPayload, type FindOrCreatePoiPayload } from '../../../../../../lib/poi';
import { json, parseJsonBody, parseIntParam } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

interface AddAlternateBody extends FindOrCreatePoiPayload {
  poiId?: unknown;
  entryPoisVersion?: unknown;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
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

  const rawBody = await parseJsonBody<unknown>(context.request);
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new AppError('DATA_VALIDATION', 'JSON body 必須是 object');
  }
  const body = rawBody as AddAlternateBody;
  if (body.entryPoisVersion != null && typeof body.entryPoisVersion !== 'string') {
    throw new AppError('DATA_VALIDATION', 'entryPoisVersion 必須是字串');
  }
  const entryPoisVersion = typeof body.entryPoisVersion === 'string'
    ? body.entryPoisVersion
    : undefined;
  let poiIdToAdd: number;

  if ('poiId' in body) {
    if (typeof body.poiId !== 'number' || !Number.isInteger(body.poiId) || body.poiId <= 0) {
      throw new AppError('DATA_VALIDATION', 'poiId 必須是 positive integer');
    }

    const poiExists = await db
      .prepare('SELECT id FROM pois WHERE id = ?')
      .bind(body.poiId)
      .first();
    if (!poiExists) throw new AppError('DATA_NOT_FOUND', `POI ${body.poiId} 不存在`);
    poiIdToAdd = body.poiId;
  } else if ('name' in body || 'lat' in body || 'lng' in body) {
    poiIdToAdd = await findOrCreatePoi(db, normalizeFindOrCreatePoiPayload(body), { policy: 'fill-null' });
  } else {
    throw new AppError('DATA_VALIDATION', '須提供 poiId 或 { name, lat, lng }');
  }

  const result = await addAlternate(db, eid, poiIdToAdd, entryPoisVersion);

  // Audit log (round 4 fix S1 — was missing on all alternates endpoints)
  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entry_pois',
    recordId: eid,
    action: 'insert',
    changedBy: auth.email,
    diffJson: JSON.stringify({ alt_added: poiIdToAdd, sort_order: result.sortOrder }),
  });

  return json({
    entryId: eid,
    poiId: poiIdToAdd,
    sortOrder: result.sortOrder,
    entryPoisVersion: result.version,
  }, 201);
};
