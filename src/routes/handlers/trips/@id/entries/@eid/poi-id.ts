/**
 * PUT /api/trips/:id/entries/:eid/poi-id — replace entry master POI
 *
 * 為什麼是獨立端點：PATCH /entries/:eid 不接受 POI 變更，避免
 * 任何編輯者改指任意 POI（跨 trip 資料外洩 / FK 違反）。這條路徑提供安全的
 * 重掛能力：驗證 POI 存在、驗證 entry 屬於這個 trip、記錄稽核。
 *
 * Body 兩種 mode（v2.23.8）：
 *   1. { poiId: number } — 直接置換成既有 POI
 *   2. { name: string, lat: number, lng: number, source?: string } — 從 search 結果
 *      新建 POI（find-or-create by lat/lng）並重掛。顯示名稱永遠取 master POI name。
 *
 * round 7 fix + round 9 cleanup: 接受可選 OCC token `entryPoisVersion` 對齊其他
 * multi-POI endpoints（PATCH /master / POST,DELETE /alternates / PATCH /alternates/reorder
 * 統一 camelCase）。若 client 帶上，setMaster 走 expectedVersion check；mismatch →
 * 409 STALE_ENTRY。沒帶仍向後相容 — UNIQUE constraint 仍能 catch true race，但 cross-tab
 * lost-update 場景需 client 帶 token 才能 detect（adversarial round 6 #2）。
 *
 * Round 8 contract specialist P2：拿掉 round 7 引入的 snake_case 別名（`entry_pois_version`），
 * 統一 camelCase。CHANGELOG 列為 round 9 cleanup — 沒 production client 用過 snake form。
 */

import { findOrCreatePoi, normalizeFindOrCreatePoiPayload, type FindOrCreatePoiPayload } from '../../../../../../lib/poi';
import { logAudit } from '../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { setMaster } from '../../../../../../lib/entry-pois';
import { json, parseJsonBody, parseIntParam } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

interface ChangePoiBody extends FindOrCreatePoiPayload {
  poiId?: unknown;
  // round 7 + round 9: OCC token (optional, camelCase only — matches other multi-POI endpoints)
  entryPoisVersion?: unknown;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, eid } = context.params as { id: string; eid: string };
  const entryId = parseIntParam(eid);
  if (!entryId) throw new AppError('DATA_VALIDATION', 'entry ID 格式錯誤');
  const db = context.env.DB;

  const [hasPerm, belongsToTrip] = await Promise.all([
    hasWritePermission(db, auth, id),
    verifyEntryBelongsToTrip(db, entryId, id),
  ]);
  if (!hasPerm) throw new AppError('PERM_DENIED');
  if (!belongsToTrip) throw new AppError('PERM_DENIED', '此 entry 不屬於該行程');

  const rawBody = await parseJsonBody<unknown>(context.request);
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new AppError('DATA_VALIDATION', 'JSON body 必須是 object');
  }
  const body = rawBody as ChangePoiBody;
  if (body.entryPoisVersion != null && typeof body.entryPoisVersion !== 'string') {
    throw new AppError('DATA_VALIDATION', 'entryPoisVersion 必須是字串');
  }
  const entryPoisVersion = typeof body.entryPoisVersion === 'string'
    ? body.entryPoisVersion
    : undefined;

  // Resolve mode：existing POI vs find-or-create mode (new from search)
  let newPoiId: number | null;
  if ('poiId' in body) {
    newPoiId = body.poiId as number;
    if (typeof newPoiId !== 'number' || !Number.isInteger(newPoiId) || newPoiId <= 0) {
      throw new AppError('DATA_VALIDATION', 'poiId 須為正整數');
    }
    const poi = await db.prepare('SELECT id FROM pois WHERE id = ?').bind(newPoiId).first();
    if (!poi) throw new AppError('DATA_NOT_FOUND', `pois.id=${newPoiId} 不存在`);
  } else if ('name' in body || 'lat' in body || 'lng' in body) {
    // find-or-create from search payload
    const poiData = normalizeFindOrCreatePoiPayload(body);
    newPoiId = await findOrCreatePoi(db, poiData, { policy: 'fill-null' });
  } else {
    throw new AppError('DATA_VALIDATION', '須提供 poiId 或 { name, lat, lng }');
  }

  const oldRow = await db
    .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
    .bind(entryId)
    .first<{ poi_id: number | null }>();
  if (!oldRow) throw new AppError('DATA_NOT_FOUND', '找不到 entry');

  // round 7 fix: pass OCC token through to setMaster (adversarial #2 — was bypassed).
  await setMaster(db, entryId, newPoiId, entryPoisVersion);

  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entries',
    recordId: entryId,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({ masterPoiId: { old: oldRow.poi_id, new: newPoiId } }),
  });

  return json({ ok: true, poiId: newPoiId });
};
