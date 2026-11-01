import { logAudit } from '../../../../../../lib/audit';
import { requireAuth, requireTripWrite } from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { json } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

// v2.29.0: trip_pois 整表 DROPPED。trip_entries.{time, poi_id, travel_*} 8 cols +
// trip_destinations.{osm_id, osm_type} 2 cols 同步 DROPPED。
// 指向已 drop table / cols 的歷史 audit row rollback 會 hard-fail with clear error
// ('無效的表格名稱' / '無效的欄位')，admin 看到時知道「這個 audit 是 cutover 前的，不能 rollback」。
const ALLOWED_TABLES = ['trips', 'trip_days', 'trip_entries', 'pois', 'poi_relations', 'trip_requests', 'trip_permissions'] as const;
type AllowedTable = typeof ALLOWED_TABLES[number];

const TABLE_COLUMNS: Record<AllowedTable, readonly string[]> = {
  // v2.31.36 (migration 0068): DROP default_travel_mode + 5 self_drive_* — dead columns。
  trips:            ['id', 'name', 'owner_user_id', 'title', 'description', 'countries', 'published', 'data_source', 'lang', 'created_at', 'updated_at'],
  // v2.29.0: hotel_poi_id ADDED (migration 0060).
  trip_days:        ['id', 'trip_id', 'day_num', 'date', 'day_of_week', 'label', 'hotel_poi_id', 'updated_at'],
  // v2.29.0: time / poi_id / travel_* (6 cols) DROPPED (migration 0062).
  // migration 0078: note DROPPED — 備註改 per-(entry, poi) trip_entry_pois.note。
  // 指向 note 的歷史 update/delete audit rollback 會在 whitelist 階段乾淨拒絕
  // （400 DATA_VALIDATION「Invalid column(s)」），不再通過後撞 "no such column: note"。
  trip_entries:     ['id', 'day_id', 'sort_order', 'start_time', 'end_time', 'description', 'source', 'entry_pois_version', 'updated_at'],
  // v2.55.78: photos 移出 whitelist — POI 照片功能移除。0038 規劃的 Wikimedia backfill
  // 從未執行，且結構上從不存在寫入路徑（本 API 的 ALLOWED_FIELDS 不含 photos）→ 恆為 NULL。
  // 欄位本身由 migration 0086 DROP，走後續 PR（見該檔的 Deploy 順序：CI 會在 push 命中
  // migrations/** 時自動 apply，故 DROP 必須晚於本 code 部署，否則舊 code 的
  // `SELECT p.photos` 會 500）。
  // 本行先落地是**刻意的、fail-closed 的**：photos 還在 schema 時把它擋在 whitelist 外，
  // 最壞只是多拒一個 rollback；反過來（DROP 先、whitelist 後）則會讓 snapshot 通過
  // whitelist 後撞 "no such column: photos" 變 opaque 500。
  // pois snapshot 由 `SELECT *` 產生、必帶 photos key → 在 whitelist 階段乾淨拒絕
  // （400「Invalid column(s)」）。同 0062/0078 慣例 —— 含 tests/api 的鎖，不只註解。
  pois:             ['id', 'type', 'name', 'description', 'note', 'address', 'phone', 'email', 'website', 'hours', 'rating', 'category', 'lat', 'lng', 'country', 'source', 'osm_id', 'osm_type', 'wikidata_id', 'cuisine', 'data_source', 'data_fetched_at', 'place_id', 'status', 'status_reason', 'status_checked_at', 'last_refreshed_at', 'price', 'created_at', 'updated_at'],
  poi_relations:    ['id', 'poi_id', 'related_poi_id', 'relation_type', 'note'],
  // V2 cutover (migration 0048 phase 1): trip_requests.mode is vestigial (nullable, no CHECK).
  // Phase 2 (follow-up) will DROP COLUMN. Rollback path no longer references mode.
  trip_requests:    ['id', 'trip_id', 'message', 'submitted_by', 'reply', 'status', 'actions_taken', 'created_at'],
  trip_permissions: ['id', 'user_id', 'trip_id', 'role', 'created_at'],
};

interface AuditRow {
  id: number;
  trip_id: string;
  table_name: string;
  record_id: number | null;
  action: 'insert' | 'update' | 'delete';
  changed_by: string | null;
  request_id: number | null;
  diff_json: string | null;
  snapshot: string | null;
  created_at: string;
}

// POST /api/trips/:id/audit/:aid/rollback
// Auth: per-trip owner/member（requireTripWrite；Phase 3 移除全域 admin）
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const { id, aid } = context.params as { id: string; aid: string };
  const db = context.env.DB;
  // Phase 1（移除全域 admin / D4）：rollback 改 per-trip owner gate（owner/member 可 rollback 自己 trip）。
  await requireTripWrite(db, auth, id);
  const changedBy = auth.email;

  const auditRow = await db
    .prepare('SELECT * FROM audit_log WHERE id = ? AND trip_id = ?')
    .bind(Number(aid), id)
    .first() as AuditRow | null;

  if (!auditRow) throw new AppError('DATA_NOT_FOUND', '找不到此 audit 記錄');

  const { table_name, record_id, action, diff_json, snapshot } = auditRow;

  const safeTable = ALLOWED_TABLES.find(t => t === table_name);
  if (!safeTable) {
    throw new AppError('DATA_VALIDATION', '無效的表格名稱');
  }
  const allowedCols = TABLE_COLUMNS[safeTable];

  if (action === 'delete') {
    // Re-INSERT using the snapshot
    if (!snapshot) throw new AppError('DATA_VALIDATION', '無可用的快照進行回滾');

    let snapshotRow: Record<string, unknown>;
    try {
      snapshotRow = JSON.parse(snapshot);
    } catch {
      throw new AppError('DATA_VALIDATION', '快照 JSON 格式無效');
    }

    // Remove system-managed fields that should be auto-generated, keep the original id
    // Also validate column names against the whitelist
    const snapshotKeys = Object.keys(snapshotRow).filter(k => k !== 'updated_at' && k !== 'created_at');
    const invalidSnapshotCols = snapshotKeys.filter(k => !allowedCols.includes(k));
    if (invalidSnapshotCols.length > 0) {
      throw new AppError('DATA_VALIDATION', `Invalid column(s) in snapshot: ${invalidSnapshotCols.join(', ')}`);
    }
    const cols = snapshotKeys.join(', ');
    const placeholders = snapshotKeys.map(() => '?').join(', ');
    const values = snapshotKeys.map(k => snapshotRow[k] ?? null);

    // Check if a record with this id already exists to avoid overwriting newer data
    if (snapshotRow.id != null) {
      const existing = await db.prepare(`SELECT 1 FROM ${safeTable} WHERE id = ?`).bind(snapshotRow.id).first();
      if (existing) {
        throw new AppError('DATA_CONFLICT', '無法回滾：此 ID 的記錄已存在');
      }
    }
    await db.prepare(`INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders})`).bind(...values).run();

    await logAudit(db, {
      tripId: id,
      tableName: safeTable,
      recordId: record_id,
      action: 'insert',
      changedBy,
      diffJson: JSON.stringify({ rollback_of: auditRow.id, original_action: 'delete' }),
    });

    return json({ ok: true, rolled_back: 'delete->re-insert' });
  }

  if (action === 'update') {
    // Revert fields using diff_json old values
    if (!diff_json) throw new AppError('DATA_VALIDATION', '無 diff 資料可回滾');
    if (record_id === null) throw new AppError('DATA_VALIDATION', '缺少 record_id 無法回滾');

    let diff: Record<string, { old: unknown; new: unknown }>;
    try {
      diff = JSON.parse(diff_json);
    } catch {
      throw new AppError('DATA_VALIDATION', 'diff JSON 格式無效');
    }

    const revertFields = Object.keys(diff);
    if (revertFields.length === 0) throw new AppError('DATA_VALIDATION', '無欄位可還原');

    const invalidDiffCols = revertFields.filter(f => !allowedCols.includes(f));
    if (invalidDiffCols.length > 0) {
      throw new AppError('DATA_VALIDATION', `Invalid column(s) in diff: ${invalidDiffCols.join(', ')}`);
    }

    // Only bump updated_at on tables that actually have the column. poi_relations,
    // trip_requests and trip_permissions have none — adding it would throw
    // "no such column: updated_at" at prepare() time on an admin rollback.
    // Derive from TABLE_COLUMNS (the file's own schema allowlist) so this can
    // never drift out of sync with the column set above.
    const withUpdatedAt = TABLE_COLUMNS[safeTable].includes('updated_at');
    const setClauses = [
      ...revertFields.map(f => `${f} = ?`),
      ...(withUpdatedAt ? ['updated_at = CURRENT_TIMESTAMP'] : []),
    ].join(', ');
    const values = [...revertFields.map(f => diff[f]?.old ?? null), record_id];

    const result = await db
      .prepare(`UPDATE ${safeTable} SET ${setClauses} WHERE id = ?`)
      .bind(...values)
      .run();

    if (result.meta.changes === 0) throw new AppError('DATA_NOT_FOUND', '找不到要還原的記錄');

    const revertedFields = Object.fromEntries(revertFields.map(f => [f, diff[f]?.old]));
    await logAudit(db, {
      tripId: id,
      tableName: safeTable,
      recordId: record_id,
      action: 'update',
      changedBy,
      diffJson: JSON.stringify({ rollback_of: auditRow.id, reverted: revertedFields }),
    });

    return json({ ok: true, rolled_back: 'update->revert' });
  }

  if (action === 'insert') {
    // DELETE the record that was inserted
    if (record_id === null) throw new AppError('DATA_VALIDATION', '缺少 record_id 無法回滾');

    const oldRow = await db.prepare(`SELECT * FROM ${safeTable} WHERE id = ?`).bind(record_id).first() as Record<string, unknown> | null;

    const delResult = await db.prepare(`DELETE FROM ${safeTable} WHERE id = ?`).bind(record_id).run();
    if (delResult.meta.changes === 0) {
      // Nothing deleted → record already gone; don't write a phantom delete-audit.
      throw new AppError('DATA_NOT_FOUND', '找不到要回滾的記錄（insert→delete）');
    }

    await logAudit(db, {
      tripId: id,
      tableName: safeTable,
      recordId: record_id,
      action: 'delete',
      changedBy,
      snapshot: oldRow ? JSON.stringify(oldRow) : undefined,
      diffJson: JSON.stringify({ rollback_of: auditRow.id, original_action: 'insert' }),
    });

    return json({ ok: true, rolled_back: 'insert->delete' });
  }

  throw new AppError('DATA_VALIDATION', `Unknown action: ${action}`);
};
