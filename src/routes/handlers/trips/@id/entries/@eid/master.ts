/**
 * PATCH /api/trips/:id/entries/:eid/master — 設定/變更 entry 的 master POI
 *
 * v2.27.0 multi-POI per entry 的核心 mutating endpoint。Body:
 *   - poiId: number             — 新 master POI id（可為現有 alternate 或全新 POI）
 *   - entryPoisVersion?: string — OCC token; mismatch → 409 STALE_ENTRY
 *   - version?: string          — alias for entryPoisVersion (legacy, accepted for
 *                                  backwards compat; new clients should use entryPoisVersion
 *                                  which matches GET response field name)
 *
 * 行為（per design doc + Codex Finding #1, #2, #3）：
 *   - poiId 是現有 alternate → swap sort_order（master 降為 alternate）
 *   - poiId 是新 POI → 既有 master 推到 max+1, INSERT 新 master sort_order=1
 *   - 同 TX mark from/to segments stale
 *   - 失敗 throw AppError；STALE_ENTRY 409 表示 version mismatch（client 該 refetch）
 *
 * Note: actual Google Routes recompute 不在這 endpoint 內觸發（frontend useTripSegments
 * 透過 computed_at=NULL detect 後 POST /recompute-travel；簡化 v2.27.0 scope）。
 */
import { logAudit } from '../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { setMaster } from '../../../../../../lib/entry-pois';
import { json, parseJsonBody, parseIntParam } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

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

  const body = await parseJsonBody<{ poiId?: number; version?: string; entryPoisVersion?: string }>(context.request);
  if (typeof body.poiId !== 'number' || !Number.isInteger(body.poiId) || body.poiId <= 0) {
    throw new AppError('DATA_VALIDATION', 'poiId 必須是 positive integer');
  }

  // round 4 fix A1: accept both entryPoisVersion (preferred, matches GET response)
  // and legacy version (kept for any client wired before this rename landed).
  const expectedVersion = body.entryPoisVersion ?? body.version;

  // 確認 POI 存在
  const poiExists = await db
    .prepare('SELECT id FROM pois WHERE id = ?')
    .bind(body.poiId)
    .first();
  if (!poiExists) throw new AppError('DATA_NOT_FOUND', `POI ${body.poiId} 不存在`);

  const result = await setMaster(db, eid, body.poiId, expectedVersion);

  // Audit log (round 4 fix S1 — was missing on all new alternates/master endpoints)
  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entry_pois',
    recordId: eid,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({
      master_swap: { from: result.oldMasterPoiId, to: body.poiId },
    }),
  });

  return json({
    entryId: eid,
    masterPoiId: body.poiId,
    oldMasterPoiId: result.oldMasterPoiId,
    entryPoisVersion: result.version,
  });
};
