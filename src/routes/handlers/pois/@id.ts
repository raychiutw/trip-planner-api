/**
 * PATCH /api/pois/:id — 修改 master POI (C2)
 * DELETE /api/pois/:id — 刪除 master POI（ops:poi 維運 token only，會先刪除所有關聯）
 *
 * ops:poi 維運 token: 可不帶 tripId（向下相容 tp-patch/tp-rebuild）
 * 一般 user: 必須帶 tripId，檢查 hasWritePermission + POI 屬於該 trip（requirePoiWrite）
 */

import { logAudit, computeDiff } from '../../../lib/audit';
import { requireAuth, hasOpsScope, requirePoiWrite } from '../../../lib/permissions';
import { AppError } from '../../../errors';
import { json, parseJsonBody, buildUpdateClause, parseIntParam } from '../../../lib/utils';
import type { Env } from '../../../env';

// Migration 0045: rename google_rating → rating; drop maps (use mapsUrl helper).
// Added 6 OSM追溯 cols editable by enrich endpoint (commit 6) but exposed here
// for tp-* skill batch updates.
// Migration 0051 (v2.23.0 google-maps-migration): added place_id (Google canonical id)
// + 4 lifecycle cols. osm_id/osm_type/wikidata_id/cuisine 仍 ALLOWED 為 forward-fix
// safety net（schema column 不 drop），但新建 POI 應只填 place_id。
const ALLOWED_FIELDS = [
  'name', 'description', 'note', 'address', 'phone', 'email', 'website',
  'hours', 'rating', 'price', 'category', 'lat', 'lng',
  'country', 'source',
  'osm_id', 'osm_type', 'wikidata_id', 'cuisine', 'data_source',
  'place_id', 'status', 'status_reason', 'status_checked_at', 'last_refreshed_at',
] as const;

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const poiId = parseIntParam(context.params.id as string);
  if (!poiId) throw new AppError('DATA_VALIDATION', 'POI ID 格式錯誤');

  const db = context.env.DB;
  const body = await parseJsonBody<Record<string, unknown>>(context.request);

  // --- 權限檢查 ---
  const tripId = body.tripId as string | undefined;
  delete body.tripId; // tripId 不是 POI 欄位，從 update payload 移除

  const oldRow = await db.prepare('SELECT * FROM pois WHERE id = ?').bind(poiId).first();
  if (!oldRow) throw new AppError('DATA_NOT_FOUND', '找不到此 POI');

  // Phase 1（移除全域 admin / F1）：master POI 寫入授權集中於 requirePoiWrite —
  // service token ops:poi 直接放行（cron 維運），否則 user 走 owner + tripId 連結檢查。
  await requirePoiWrite(db, auth, poiId, tripId);

  const update = buildUpdateClause(body, ALLOWED_FIELDS as unknown as string[]);
  if (!update) throw new AppError('DATA_VALIDATION', '無有效欄位可更新');

  const newRow = await db.prepare(`UPDATE pois SET ${update.setClauses} WHERE id = ? RETURNING *`)
    .bind(...update.values, poiId).first();
  if (!newRow) throw new AppError('SYS_INTERNAL', 'UPDATE RETURNING 未回傳資料');
  const diffJson = computeDiff(oldRow as Record<string, unknown>, newRow as Record<string, unknown>);

  await logAudit(db, {
    tripId: tripId || 'global',
    tableName: 'pois',
    recordId: poiId,
    action: 'update',
    changedBy: auth.email,
    diffJson,
  });

  return json(newRow);
};

/**
 * DELETE /api/pois/:id — 刪除 master POI + 所有 canonical/contextual 關聯
 * ops:poi 維運 scope only（Phase 3：移除全域 admin，維運走細粒度 ops scope）
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  if (!hasOpsScope(auth, 'ops:poi')) throw new AppError('PERM_DENIED', '僅 ops:poi 維運 token 可刪除 master POI');

  const poiId = parseIntParam(context.params.id as string);
  if (!poiId) throw new AppError('DATA_VALIDATION', 'POI ID 格式錯誤');

  const db = context.env.DB;

  const oldRow = await db.prepare('SELECT * FROM pois WHERE id = ?').bind(poiId).first();
  if (!oldRow) throw new AppError('DATA_NOT_FOUND', '找不到此 POI');

  // v2.29.0: trip_pois DROPPED, trip_entries.poi_id DROPPED. 只剩 trip_days.hotel_poi_id
  // 需要 cascade clean (SQLite ALTER TABLE ADD COLUMN 不 enforce FK)。
  await db.prepare('UPDATE trip_days SET hotel_poi_id = NULL WHERE hotel_poi_id = ?').bind(poiId).run();

  // trip_entry_pois.poi_id REFERENCES pois(id) ON DELETE RESTRICT, so canonical
  // entry POI rows must be deleted before the POI master.
  const junctionBefore = await db
    .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE poi_id = ?')
    .bind(poiId)
    .first<{ c: number }>();
  const deletedJunctionCount = junctionBefore?.c ?? 0;
  await db.prepare('DELETE FROM trip_entry_pois WHERE poi_id = ?').bind(poiId).run();

  // 刪除 pois master
  await db.prepare('DELETE FROM pois WHERE id = ?').bind(poiId).run();

  await logAudit(db, {
    tripId: 'global',
    tableName: 'pois',
    recordId: poiId,
    action: 'delete',
    changedBy: auth.email,
    snapshot: JSON.stringify(oldRow),
  });

  return json({
    ok: true,
    deleted_trip_entry_pois: deletedJunctionCount,
  });
};
