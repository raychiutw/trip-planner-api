/**
 * PATCH /api/trips/:id/entries/:eid/pois/:poiId — 編輯該 entry 下某個 POI。
 *
 * Body（note / poi_type / reservation 至少一個）:
 *   - note: string | null — per-POI 備註（migration 0078）。trim 後空字串 → NULL（清除）。
 *       長度上限 1000；亂碼 → 400 DATA_ENCODING；非 string|null → 400 DATA_VALIDATION。
 *   - poi_type: string — 改該 POI 的分類（whitelist：hotel/restaurant/shopping/parking/
 *       attraction/transport/activity/other）。
 *   - reservation: string | null — per-POI 訂位資訊文字。trim 後空 → NULL；長度上限 500；
 *       亂碼 → 400。寫入防堵（D）：被誤存成 JSON 的訂位狀態 → normalizeReservation 轉人話文字。
 *
 * ## poi_type re-point 模型（重要）
 *
 * 分類是 pois master 的屬性，master 跨 entry 共用且有 UNIQUE(name,type)（migration 0018）。
 * 改分類**不**直接 mutate 共用 master（會改到別的 entry / 撞 unique），而是：
 *   1. findOrCreatePoi({ name, type: newType, ...其餘欄位 }) → 取得「同名 + 新分類」的
 *      master（既有則回該 id；無則用本 POI 欄位複製一筆新的）。
 *   2. re-point：UPDATE trip_entry_pois SET poi_id = newPoiId WHERE (entry, oldPoiId)。
 * 只動「這個停留點的這一列」（正選 sort_order=1 或某備選 sort_order>1），note / sort_order
 * 保留（同一列、只換 poi_id）。其他 entry 參照舊 master 不受影響。撞既有 row 自動 dedup，
 * 永不建重複、不失敗。極端：此 entry 已參照 newPoiId（同名同類已是另一候選）→ 400。
 *
 * 權限：requireAuth + hasWritePermission + verifyEntryBelongsToTrip + (entry,poi) 存在驗證。
 * 並發：LWW。**刻意不** bump entry_pois_version（結構 OCC counter 專用，見 _entry_pois.ts）。
 * 回傳：{ entryId, poiId（re-point 後的 effective id）, type, note }。
 */
import { logAudit, computeDiff } from '../../../../../../../lib/audit';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth } from '../../../../../../../lib/permissions';
import { AppError } from '../../../../../../../errors';
import { detectGarbledText } from '../../../../../../../lib/validate';
import { json, parseJsonBody, parseIntParam } from '../../../../../../../lib/utils';
import { findOrCreatePoi } from '../../../../../../../lib/poi';
import { normalizeReservation } from '../../../../../../../lib/reservation';
import type { Env } from '../../../../../../../env';

/** per-POI 備註長度上限（trim 後計），對齊既有文字欄位慣例。 */
const NOTE_MAX_LEN = 1000;
/** reservation 文字長度上限，對齊 import strOrNull(reservation, 500)。 */
const RESERVATION_MAX_LEN = 500;
/** poi_type 白名單，對齊 entries.ts ALLOWED_POI_TYPES 與 pois.type CHECK constraint。 */
const ALLOWED_POI_TYPES = new Set([
  'hotel', 'restaurant', 'shopping', 'parking', 'attraction', 'transport', 'activity', 'other',
]);

interface MasterRow {
  curNote: string | null;
  curReservation: string | null;
  name: string;
  curType: string;
  description: string | null;
  hours: string | null;
  rating: number | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
  source: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  country: string | null;
  price: string | null;
  place_id: string | null;
  // Migration 0051 lifecycle — 換分類複製整筆時要一起帶到 clone，否則 closed/missing
  // 的真實地點換分類後會被重設成 active（歇業警告消失）。
  status: string | null;
  status_reason: string | null;
  status_checked_at: string | null;
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
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

  const body = await parseJsonBody<{ note?: unknown; poi_type?: unknown; reservation?: unknown }>(context.request);
  const hasNote = 'note' in body;
  const hasType = 'poi_type' in body;
  const hasReservation = 'reservation' in body;
  if (!hasNote && !hasType && !hasReservation) {
    throw new AppError('DATA_VALIDATION', '缺少 note / poi_type / reservation 欄位');
  }

  // ── validate poi_type ──
  let newType: string | null = null;
  if (hasType) {
    if (typeof body.poi_type !== 'string' || !ALLOWED_POI_TYPES.has(body.poi_type)) {
      throw new AppError('DATA_VALIDATION', `poi_type 無效（允許：${[...ALLOWED_POI_TYPES].join(', ')}）`);
    }
    newType = body.poi_type;
  }

  // ── validate note ──
  let note: string | null = null;
  if (hasNote) {
    if (body.note !== null && typeof body.note !== 'string') {
      throw new AppError('DATA_VALIDATION', 'note 必須是字串或 null');
    }
    note = body.note === null ? null : (body.note as string).trim();
    if (note === '') note = null;
    if (note !== null) {
      if (note.length > NOTE_MAX_LEN) {
        throw new AppError('DATA_VALIDATION', `note 不得超過 ${NOTE_MAX_LEN} 字`);
      }
      if (detectGarbledText(note)) {
        throw new AppError('DATA_ENCODING', 'note 包含疑似亂碼，請確認 encoding 為 UTF-8');
      }
    }
  }

  // ── validate + 正規化 reservation（D 寫入防堵：被誤存的 JSON → 人話文字）──
  let reservation: string | null = null;
  if (hasReservation) {
    if (body.reservation !== null && typeof body.reservation !== 'string') {
      throw new AppError('DATA_VALIDATION', 'reservation 必須是字串或 null');
    }
    // normalizeReservation：JSON-shaped 訂位狀態 → 文字；純文字原樣（防 client/AI 寫 JSON 進此欄）。
    const normalized = body.reservation === null ? null : normalizeReservation(body.reservation as string);
    reservation = normalized === null ? null : normalized.trim();
    if (reservation === '') reservation = null;
    if (reservation !== null) {
      if (reservation.length > RESERVATION_MAX_LEN) {
        throw new AppError('DATA_VALIDATION', `reservation 不得超過 ${RESERVATION_MAX_LEN} 字`);
      }
      if (detectGarbledText(reservation)) {
        throw new AppError('DATA_ENCODING', 'reservation 包含疑似亂碼，請確認 encoding 為 UTF-8');
      }
    }
  }

  // ── 取現有 (entry, poi) junction + master 欄位（複製到新分類 row 用） ──
  const existing = await db
    .prepare(
      `SELECT tep.note AS curNote, tep.reservation AS curReservation, p.name, p.type AS curType, p.description, p.hours, p.rating,
              p.category, p.lat, p.lng, p.source, p.address, p.phone, p.email, p.website,
              p.country, p.price, p.place_id, p.status, p.status_reason, p.status_checked_at
         FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id
        WHERE tep.entry_id = ? AND tep.poi_id = ?`,
    )
    .bind(eid, poiId)
    .first<MasterRow>();
  if (!existing) throw new AppError('DATA_NOT_FOUND', `POI ${poiId} 不在 entry ${eid}`);

  const now = new Date().toISOString();
  let effectivePoiId = poiId;
  let finalType = existing.curType;

  // ── poi_type 變更 → re-point 到「同名 + 新分類」master ──
  if (newType && newType !== existing.curType) {
    const newPoiId = await findOrCreatePoi(db, {
      name: existing.name,
      type: newType,
      description: existing.description,
      hours: existing.hours,
      rating: existing.rating,
      category: existing.category,
      lat: existing.lat,
      lng: existing.lng,
      source: existing.source,
      address: existing.address,
      phone: existing.phone,
      email: existing.email,
      website: existing.website,
      country: existing.country,
      price: existing.price,
      place_id: existing.place_id,
      // lifecycle 帶入 clone（只在「建新 (name, newType) row」時生效；撞既有 row → 不覆寫）。
      status: existing.status,
      status_reason: existing.status_reason,
      status_checked_at: existing.status_checked_at,
    }, { policy: 'fill-null' });
    if (newPoiId !== poiId) {
      // UNIQUE(entry_id, poi_id) guard：此 entry 不可已參照 newPoiId（同名同類已是另一候選）。
      const dup = await db
        .prepare('SELECT 1 FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
        .bind(eid, newPoiId)
        .first();
      if (dup) throw new AppError('DATA_VALIDATION', '此停留點已有相同名稱的該分類景點');
      await db
        .prepare('UPDATE trip_entry_pois SET poi_id = ?, updated_at = ? WHERE entry_id = ? AND poi_id = ?')
        .bind(newPoiId, now, eid, poiId)
        .run();
      effectivePoiId = newPoiId;
    }
    finalType = newType;
  }

  // ── note 變更（套在 re-point 後的 effective row 上） ──
  let finalNote = existing.curNote;
  if (hasNote) {
    await db
      .prepare('UPDATE trip_entry_pois SET note = ?, updated_at = ? WHERE entry_id = ? AND poi_id = ?')
      .bind(note, now, eid, effectivePoiId)
      .run();
    finalNote = note;
  }

  // ── reservation 變更（同 effective row）──
  let finalReservation = existing.curReservation;
  if (hasReservation) {
    await db
      .prepare('UPDATE trip_entry_pois SET reservation = ?, updated_at = ? WHERE entry_id = ? AND poi_id = ?')
      .bind(reservation, now, eid, effectivePoiId)
      .run();
    finalReservation = reservation;
  }

  await logAudit(db, {
    tripId: id,
    tableName: 'trip_entry_pois',
    recordId: eid,
    action: 'update',
    changedBy: auth.email,
    diffJson: computeDiff(
      { poiId, type: existing.curType, note: existing.curNote, reservation: existing.curReservation },
      { poiId: effectivePoiId, type: finalType, note: finalNote, reservation: finalReservation },
    ),
  });

  return json({ entryId: eid, poiId: effectivePoiId, type: finalType, note: finalNote, reservation: finalReservation });
};
