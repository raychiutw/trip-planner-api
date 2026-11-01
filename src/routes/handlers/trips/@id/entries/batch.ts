/**
 * PATCH /api/trips/:id/entries/batch — 一次更新多個 entries 的 sort_order /
 * day_id / start_time / end_time，drag-drop reorder 結束後背景 commit 用。
 *
 * Contract: 用單一 transaction batch update，避免 drag-drop reorder 的 N+1 寫入。
 *
 * Naming: DB 與 endpoint 使用 `sort_order`，對齊 PATCH /entries/:eid 既有
 * contract；前端 mapper 在 IdeasTab/Timeline 處理。
 *
 * v2.29.0 (migration 0062): trip_entries.{time, travel_*} 8 cols DROPPED。
 *   - `time` legacy → start_time/end_time 拆分（v2.26 起 dual-write）
 *   - travel_* → trip_segments 為唯一 source（PATCH /api/trips/:id/segments）
 *
 * 安全：
 *   - 認證 + trip permission 必驗
 *   - 每個 update.id 必須屬於 path tripId（join trip_days）
 *   - 任一 day_id 跨天 move 必須屬於同 tripId（防越權）
 *   - 全 atomic 透過 db.batch() — 一筆失敗整批 rollback
 */
import { logAudit } from '../../../../../lib/audit';
import { requireAuth, requireTripWrite } from '../../../../../lib/permissions';
import { TIME_RE } from '../../../../../lib/time';
import { AppError } from '../../../../../errors';
import { json, parseJsonBody, buildUpdateClause } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';

const ALLOWED_FIELDS = ['sort_order', 'day_id', 'start_time', 'end_time'] as const;

interface BatchUpdateItem {
  id: number;
  fields: Record<string, unknown>;
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const { id: tripId } = context.params as { id: string };
  const db = context.env.DB;

  await requireTripWrite(db, auth, tripId);

  const body = await parseJsonBody<{ updates?: unknown }>(context.request);
  const rawUpdates = body.updates;
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    throw new AppError('DATA_VALIDATION', 'updates 必須是非空陣列');
  }

  const validated: BatchUpdateItem[] = [];
  for (const raw of rawUpdates) {
    if (!raw || typeof raw !== 'object') {
      throw new AppError('DATA_VALIDATION', 'updates[] 必須是物件');
    }
    const item = raw as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new AppError('DATA_VALIDATION', 'updates[].id 必須是正整數');
    }
    const fields: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in item) fields[key] = item[key];
    }
    if (Object.keys(fields).length === 0) {
      throw new AppError('DATA_VALIDATION', `updates[id=${id}] 無可更新欄位`);
    }
    if ('sort_order' in fields && (typeof fields.sort_order !== 'number' || !Number.isInteger(fields.sort_order))) {
      throw new AppError('DATA_VALIDATION', `updates[id=${id}].sort_order 必須是整數`);
    }
    if ('day_id' in fields && (typeof fields.day_id !== 'number' || !Number.isInteger(fields.day_id) || (fields.day_id as number) <= 0)) {
      throw new AppError('DATA_VALIDATION', `updates[id=${id}].day_id 必須是正整數`);
    }
    for (const tf of ['start_time', 'end_time'] as const) {
      if (tf in fields && fields[tf] != null && typeof fields[tf] !== 'string') {
        throw new AppError('DATA_VALIDATION', `updates[id=${id}].${tf} 必須是字串或 null`);
      }
      if (tf in fields && typeof fields[tf] === 'string' && fields[tf] !== '' && !TIME_RE.test(fields[tf] as string)) {
        throw new AppError('DATA_VALIDATION', `updates[id=${id}].${tf} 必須符合 HH:MM 格式`);
      }
    }
    validated.push({ id, fields });
  }

  const ids = validated.map((u) => u.id);
  const idPlaceholders = ids.map(() => '?').join(',');
  const ownership = await db
    .prepare(`SELECT e.id FROM trip_entries e JOIN trip_days d ON e.day_id = d.id WHERE e.id IN (${idPlaceholders}) AND d.trip_id = ?`)
    .bind(...ids, tripId)
    .all<{ id: number }>();
  const ownedIds = new Set(ownership.results.map((r) => r.id));
  for (const u of validated) {
    if (!ownedIds.has(u.id)) {
      throw new AppError('DATA_NOT_FOUND', `entry ${u.id} 不屬於 trip ${tripId}`);
    }
  }

  // v2.33.97 review: 防客戶端 misbehave 送同 (day_id, sort_order) duplicate →
  // 兩筆 UPDATE 都 commit but timeline order 不確定。Reject upfront 而非靠
  // DDL UNIQUE (schema 沒加 partial index 因 sort_order shift 過程允許暫態衝突)。
  const sortOrderPairs = new Set<string>();
  for (const u of validated) {
    if (typeof u.fields.sort_order === 'number') {
      // day_id 沒帶時表示 sort_order 在原 day_id 改動 — 同 day 內 dedupe
      // 需 SELECT 原 day_id 但代價高；簡化：只 dedupe 客端「同時 (day_id, sort_order)」
      // 都帶的 case (drag-drop reorder 典型 shape)。
      const key = `${u.fields.day_id ?? 'same'}-${u.fields.sort_order}`;
      if (sortOrderPairs.has(key)) {
        throw new AppError('DATA_VALIDATION', `batch 內 (day_id, sort_order)=(${u.fields.day_id ?? 'same-day'}, ${u.fields.sort_order}) 重複`);
      }
      sortOrderPairs.add(key);
    }
  }

  const targetDayIds = Array.from(new Set(
    validated
      .map((u) => u.fields.day_id)
      .filter((d): d is number => typeof d === 'number'),
  ));
  if (targetDayIds.length > 0) {
    const dayPlaceholders = targetDayIds.map(() => '?').join(',');
    const dayCheck = await db
      .prepare(`SELECT id FROM trip_days WHERE id IN (${dayPlaceholders}) AND trip_id = ?`)
      .bind(...targetDayIds, tripId)
      .all<{ id: number }>();
    const okDays = new Set(dayCheck.results.map((r) => r.id));
    for (const d of targetDayIds) {
      if (!okDays.has(d)) {
        throw new AppError('PERM_DENIED', `day ${d} 不屬於 trip ${tripId}`);
      }
    }
  }

  const statements = validated.map((u) => {
    const clause = buildUpdateClause(u.fields, ALLOWED_FIELDS);
    if (!clause) throw new AppError('DATA_VALIDATION', `updates[id=${u.id}] 無有效欄位`);
    return db.prepare(`UPDATE trip_entries SET ${clause.setClauses} WHERE id = ?`).bind(...clause.values, u.id);
  });

  try {
    await db.batch(statements);
  } catch {
    throw new AppError('SYS_DB_ERROR', 'DB 暫時無法處理，請稍後重試');
  }

  await Promise.all(validated.map((u) =>
    logAudit(db, {
      tripId,
      tableName: 'trip_entries',
      recordId: u.id,
      action: 'update',
      changedBy: auth.email,
      diffJson: JSON.stringify(u.fields),
    }),
  ));

  return json({ ok: true, updated: validated.length });
};
