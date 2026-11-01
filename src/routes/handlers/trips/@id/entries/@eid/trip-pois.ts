/**
 * POST /api/trips/:id/entries/:eid/trip-pois — 新增 POI 到 entry
 *
 * v2.29.0: trip_pois 整表 DROPPED。不論 POI type（shopping / restaurant / attraction），
 * 全部寫 trip_entry_pois as alternate (sort_order = max + 1)。
 *
 * `body.must_buy`、`body.context` legacy field 不再被處理（schema 已無對應）。
 */

import { logAudit } from '../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { findOrCreatePoi } from '../../../../../../lib/poi';
import { normalizeReservation } from '../../../../../../lib/reservation';
import { json, parseJsonBody, parseIntParam } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

export const onRequestPost: PagesFunction<Env> = async (context) => {
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

  type AddPoiBody = {
    name: string;
    type: 'restaurant' | 'shopping' | 'attraction' | 'activity' | 'transport' | 'other';
    description?: string;
    note?: string;
    hours?: string;
    rating?: number;
    category?: string;
    lat?: number;
    lng?: number;
    price?: string;
    reservation?: string;
    reservation_url?: string;
  };

  const body = await parseJsonBody<AddPoiBody>(context.request);

  if (!body.name || !body.type) {
    throw new AppError('DATA_VALIDATION', '缺少必要欄位：name, type');
  }

  // Find or create POI master
  // pois.{price, hours} 是客觀屬性，由 findOrCreatePoi 寫入。
  const poiId = await findOrCreatePoi(db, {
    name: body.name, type: body.type,
    description: body.description as string, hours: body.hours as string,
    rating: body.rating as number, category: body.category as string,
    lat: body.lat as number, lng: body.lng as number, source: 'ai',
    price: body.price as string,
  }, { policy: 'fill-null' });

  // v2.29.0: 全 type 統一寫 trip_entry_pois（sort_order = max+1 = alternate）。
  // sort_order subquery atomic with INSERT 縮 race window — concurrent POST 同 entry
  // 由 SQLite 單 writer + UNIQUE(entry_id, sort_order) catch 兜底。
  //
  // v2.33.43 security audit: 把 INSERT + UPDATE entry_pois_version 合進
  // 同一個 db.batch — 之前 INSERT 成功但 UPDATE 失敗，會留下 entry_pois_version
  // 未 bump 的 stale entry → 後續 OCC 檢查穿過，破壞「entries 改動必 bump
  // version」 invariant。D1 batch 內任一 statement 失敗會 rollback。
  const now = new Date().toISOString();
  let result;
  try {
    const batchResults = await db.batch([
      db
        .prepare(
          `INSERT INTO trip_entry_pois (
             entry_id, poi_id, sort_order, added_at, updated_at,
             description, note, reservation, reservation_url
           )
           VALUES (
             ?, ?,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM trip_entry_pois WHERE entry_id = ?),
             ?, ?, ?, ?, ?, ?
           )
           RETURNING *`,
        )
        .bind(
          entryId,
          poiId,
          entryId,
          now,
          now,
          body.description ?? null,
          body.note ?? null,
          // D 寫入防堵：JSON-shaped 訂位狀態 → 人話文字（防再污染）。
          // 非 string（client 送 object/array 繞過 TS）→ null，不讓 normalizeReservation crash（Codex #3）。
          normalizeReservation(typeof body.reservation === 'string' ? body.reservation : null),
          body.reservation_url ?? null,
        ),
      db
        .prepare('UPDATE trip_entries SET entry_pois_version = entry_pois_version + 1 WHERE id = ?')
        .bind(entryId),
    ]);
    result = (batchResults[0]?.results as Array<Record<string, unknown>> | undefined)?.[0];
    if (!result) {
      throw new AppError('SYS_DB_ERROR', 'INSERT trip_entry_pois 未回傳資料');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // v2.34.39 PR39 fix: D1 SQLITE UNIQUE error 訊息格式為
    // "UNIQUE constraint failed: trip_entry_pois.entry_id, trip_entry_pois.poi_id"
    // 中間夾 "trip_entry_pois." prefix，原 includes('entry_id, poi_id') 不 match
    // → 落到 throw err 變 500。改 includes 分開判斷 entry_id + poi_id 兩 column。
    if (msg.includes('UNIQUE') && msg.includes('entry_id') && msg.includes('poi_id')) {
      throw new AppError('DATA_CONFLICT', '此 POI 已存在於該 entry');
    }
    if (msg.includes('UNIQUE') && msg.includes('sort_order')) {
      throw new AppError('SYS_DB_ERROR', '同時新增 POI 衝突，請稍後重試');
    }
    throw err;
  }

  await logAudit(db, {
    tripId: id, tableName: 'trip_entry_pois', recordId: (result as { id: number }).id,
    action: 'insert', changedBy: auth.email,
    diffJson: JSON.stringify(body),
  });

  return json(result, 201);
};
