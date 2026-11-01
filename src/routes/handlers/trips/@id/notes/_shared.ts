/**
 * Shared helpers for per-section trip notes endpoints.
 *
 * v2.34.x 行程筆記 PR2 (GET) + PR3 (POST / PATCH / DELETE / reorder)。
 * 5 個 section 共用：auth check + SELECT * / INSERT / UPDATE / DELETE / reorder。
 * 抽出來避免 5 個 file 各寫一次。
 */
import { hasPermission, requireAuth, requireTripWrite } from '../../../../../lib/permissions';
import { logAudit, computeDiff } from '../../../../../lib/audit';
import { AppError } from '../../../../../errors';
import {
  semanticKeyForEmergency,
  semanticKeyForPretrip,
  type NoteAiDocType,
} from '../../../../../lib/note-ai';
import { buildUpdateClause, json, parseIntParam, parseJsonBody } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';

export type NotesTable =
  | 'trip_flights'
  | 'trip_lodgings'
  | 'trip_reservations'
  | 'trip_pretrip_notes'
  | 'trip_emergency_contacts';

export function getNoteAiIdentity(
  table: NotesTable,
  row: Record<string, unknown>,
): { docType: NoteAiDocType; semanticKey: string; label: string } | null {
  if (
    row.origin !== 'ai'
    || (table !== 'trip_pretrip_notes' && table !== 'trip_emergency_contacts')
  ) return null;
  if (table === 'trip_emergency_contacts') {
    const label = String(row.name ?? '');
    return {
      docType: 'emergency',
      label,
      semanticKey: typeof row.semantic_key === 'string' && row.semantic_key
        ? row.semantic_key
        : semanticKeyForEmergency(
          String(row.kind ?? 'other'),
          label,
          String(row.phone ?? ''),
        ),
    };
  }
  const docType: NoteAiDocType = row.ai_source === 'lodging-tips' ? 'lodging-tips' : 'tips';
  const label = String(row.title ?? '');
  return {
    docType,
    label,
    semanticKey: typeof row.semantic_key === 'string' && row.semantic_key
      ? row.semantic_key
      : semanticKeyForPretrip(docType, String(row.section ?? ''), label),
  };
}

function getHumanNoteSemanticKey(
  table: NotesTable,
  row: Record<string, unknown>,
): string | null {
  if (table === 'trip_pretrip_notes') {
    const topic = semanticKeyForPretrip(
      'tips',
      String(row.section ?? ''),
      String(row.title ?? ''),
    ).slice('tips:'.length);
    return topic || null;
  }
  if (table === 'trip_emergency_contacts') {
    const name = String(row.name ?? '');
    const phone = String(row.phone ?? '');
    const kind = String(row.kind ?? 'other');
    if (!name && !phone && kind === 'other') return null;
    return semanticKeyForEmergency(kind, name, phone);
  }
  return null;
}

// Per-section writable fields whitelist。snake_case 對齊 DB column + 對齊 entries
// pattern。`version` 永遠不在 whitelist — autosave 用 body.expectedVersion + SQL
// `SET version = version + 1` CAS（同 trip_entries v2.33.108 pattern）。
// `trip_id` 也不在 — 路徑 param 提供，body 不該帶 (防越權改 trip_id)。
export const ALLOWED_FIELDS: Record<NotesTable, readonly string[]> = {
  trip_flights: [
    'sort_order', 'airline', 'flight_no', 'cabin_class',
    'depart_airport', 'arrive_airport', 'depart_at', 'arrive_at', 'note',
  ],
  trip_lodgings: [
    'sort_order', 'name', 'address', 'check_in_at', 'check_out_at',
    'booking_no', 'phone', 'note',
  ],
  trip_reservations: [
    'sort_order', 'kind', 'title', 'reserved_at', 'party_size',
    'reservation_no', 'phone', 'note',
  ],
  trip_pretrip_notes: [
    'sort_order', 'section', 'title', 'content',
  ],
  trip_emergency_contacts: [
    'sort_order', 'name', 'relationship', 'phone', 'email', 'kind',
  ],
};

// CHECK enum validation（DB 也有 CHECK，這層補 415 而不是丟 500）
const KIND_ENUMS: Partial<Record<NotesTable, readonly string[]>> = {
  trip_reservations: ['restaurant', 'experience', 'ticket', 'transport', 'other'],
  trip_emergency_contacts: ['personal', 'embassy', 'police', 'medical', 'insurance', 'hotel', 'other'],
};

const AI_SOURCE_ENUM = ['lodging-tips', 'general-tips'] as const;

// ============================================================================
// READ (GET) — 既有 PR2 endpoint
// ============================================================================

export async function listNotesSection(
  context: EventContext<Env, string, Record<string, unknown>>,
  table: NotesTable,
): Promise<Response> {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;

  if (!(await hasPermission(env.DB, auth, tripId))) {
    throw new AppError('PERM_DENIED');
  }

  const { results } = await env.DB
    .prepare(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY sort_order ASC, id ASC`)
    .bind(tripId)
    .all<Record<string, unknown>>();

  return json({ items: results ?? [] });
}

// ============================================================================
// CREATE (POST) — body snake_case，回 row + 201
// ============================================================================

export async function createNotesRow(
  context: EventContext<Env, string, Record<string, unknown>>,
  table: NotesTable,
): Promise<Response> {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;

  await requireTripWrite(env.DB, auth, tripId);

  const body = await parseJsonBody<Record<string, unknown>>(context.request);
  validateEnums(table, body);

  // Auto-assign sort_order = MAX+1 if not provided（保持新 row 排最後）
  if (!('sort_order' in body)) {
    const max = await env.DB
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${table} WHERE trip_id = ?`)
      .bind(tripId)
      .first<{ m: number }>();
    body.sort_order = (max?.m ?? -1) + 1;
  }

  const allowed = ALLOWED_FIELDS[table];
  const fields = Object.keys(body).filter((k) => (allowed as readonly string[]).includes(k));
  // trip_id 永遠由 path param 提供，不從 body
  const cols = ['trip_id', ...fields];
  const values = [tripId, ...fields.map((f) => body[f])];
  const semanticKey = getHumanNoteSemanticKey(table, body);
  if (semanticKey) {
    cols.push('semantic_key');
    values.push(semanticKey);
  }
  const placeholders = cols.map(() => '?').join(', ');

  const row = await env.DB
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`)
    .bind(...values)
    .first<Record<string, unknown>>();

  // PR26: audit log for create
  if (row) {
    await logAudit(env.DB, {
      tripId,
      tableName: table,
      recordId: row.id as number,
      action: 'insert',
      changedBy: auth.email,
      diffJson: JSON.stringify(row),
    });
  }

  return json(row, 201);
}

// ============================================================================
// UPDATE (PATCH) — body snake_case + optional expectedVersion OCC
// ============================================================================

export async function updateNotesRow(
  context: EventContext<Env, string, Record<string, unknown>>,
  table: NotesTable,
): Promise<Response> {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;
  // 注意：params.id 是 trip-id (string)，rowId 是 numeric — 從第二個 [rowId] segment
  // CF Pages 把 [rowId] 變 params.rowId。
  if (!params.rowId) throw new AppError('DATA_VALIDATION', 'rowId 缺失');
  const id = parseIntParam(params.rowId as string);
  if (!id) throw new AppError('DATA_VALIDATION', 'rowId 必須是正整數');

  await requireTripWrite(env.DB, auth, tripId);

  // 驗證 row 屬於該 trip（防越權）+ 抓 oldRow 給 audit diff
  const oldRow = await env.DB
    .prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!oldRow) throw new AppError('DATA_NOT_FOUND');
  if (oldRow.trip_id !== tripId) throw new AppError('PERM_DENIED', '此 row 不屬於該 trip');

  const body = await parseJsonBody<Record<string, unknown>>(context.request);
  validateEnums(table, body);

  // OCC token — 對齊 entries [eid].ts pattern
  const expectedVersion = typeof body.expectedVersion === 'number'
    && Number.isInteger(body.expectedVersion)
    ? body.expectedVersion
    : null;
  if (expectedVersion !== null) delete body.expectedVersion;

  const update = buildUpdateClause(body, ALLOWED_FIELDS[table]);
  if (!update) {
    throw new AppError('DATA_VALIDATION', '無有效欄位可更新');
  }

  let row;
  try {
    const contentFields: Partial<Record<NotesTable, readonly string[]>> = {
      trip_pretrip_notes: ['section', 'title', 'content'],
      trip_emergency_contacts: ['name', 'relationship', 'phone', 'email', 'kind'],
    };
    const editsNoteContent = update.fields.some((field) => contentFields[table]?.includes(field));
    const editsAiContent = oldRow.origin === 'ai' && editsNoteContent;
    const transfersToHuman = editsAiContent && oldRow.managed_by === 'ai';
    const aiIdentity = editsAiContent
      ? getNoteAiIdentity(table, { ...oldRow, ...body, semantic_key: null })
      : null;
    const semanticKey = aiIdentity?.semanticKey
      ?? (editsNoteContent ? getHumanNoteSemanticKey(table, { ...oldRow, ...body }) : undefined);
    const maintenanceClause = semanticKey !== undefined
      ? `${transfersToHuman ? ", managed_by = 'human'" : ''}, semantic_key = ?`
      : '';
    const maintenanceValues = semanticKey !== undefined ? [semanticKey] : [];
    const setClausesWithVersion = `${update.setClauses}${maintenanceClause}, version = version + 1, updated_at = datetime('now')`;
    if (expectedVersion !== null) {
      row = await env.DB
        .prepare(`UPDATE ${table} SET ${setClausesWithVersion} WHERE id = ? AND version = ? RETURNING *`)
        .bind(...update.values, ...maintenanceValues, id, expectedVersion)
        .first<Record<string, unknown>>();
      if (!row) {
        const cur = await env.DB
          .prepare(`SELECT version FROM ${table} WHERE id = ?`)
          .bind(id)
          .first<{ version: number }>();
        if (!cur) throw new AppError('DATA_NOT_FOUND');
        throw new AppError('STALE_ENTRY', `expected version ${expectedVersion}, current ${cur.version}`);
      }
    } else {
      row = await env.DB
        .prepare(`UPDATE ${table} SET ${setClausesWithVersion} WHERE id = ? RETURNING *`)
        .bind(...update.values, ...maintenanceValues, id)
        .first<Record<string, unknown>>();
    }
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/CHECK constraint/i.test(msg) || /SQLITE_CONSTRAINT_CHECK/i.test(msg)) {
      throw new AppError('DATA_VALIDATION', 'CHECK constraint failed (enum 違反)');
    }
    if (/FOREIGN KEY constraint/i.test(msg) || /SQLITE_CONSTRAINT_FOREIGNKEY/i.test(msg)) {
      throw new AppError('DATA_VALIDATION', '欄位參考的資料不存在');
    }
    throw err;
  }

  if (!row) throw new AppError('DATA_NOT_FOUND');

  // PR26: audit log for update
  if (row) {
    const newFields = Object.fromEntries(update.fields.map((f) => [f, body[f]]));
    if (oldRow.origin === 'ai' && oldRow.managed_by === 'ai' && row.managed_by === 'human') {
      newFields.managed_by = 'human';
    }
    await logAudit(env.DB, {
      tripId,
      tableName: table,
      recordId: id,
      action: 'update',
      changedBy: auth.email,
      diffJson: computeDiff(oldRow, newFields),
    });
  }

  return json(row);
}

// ============================================================================
// DELETE
// ============================================================================

export async function deleteNotesRow(
  context: EventContext<Env, string, Record<string, unknown>>,
  table: NotesTable,
): Promise<Response> {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;
  if (!params.rowId) throw new AppError('DATA_VALIDATION', 'rowId 缺失');
  const id = parseIntParam(params.rowId as string);
  if (!id) throw new AppError('DATA_VALIDATION', 'rowId 必須是正整數');

  await requireTripWrite(env.DB, auth, tripId);

  const oldRow = await env.DB
    .prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!oldRow) throw new AppError('DATA_NOT_FOUND');
  if (oldRow.trip_id !== tripId) throw new AppError('PERM_DENIED', '此 row 不屬於該 trip');

  let excluded = false;
  const aiIdentity = getNoteAiIdentity(table, oldRow);
  if (aiIdentity) {
    const deleteStatement = table === 'trip_pretrip_notes'
      ? env.DB.prepare(
        `DELETE FROM trip_pretrip_notes
         WHERE trip_id = ?
           AND (
             id = ?
             OR (
               origin = 'ai'
               AND managed_by = 'ai'
               AND ai_source = ?
               AND semantic_key = ?
             )
           )`,
      ).bind(
        tripId,
        id,
        aiIdentity.docType === 'lodging-tips' ? 'lodging-tips' : 'general-tips',
        aiIdentity.semanticKey,
      )
      : env.DB.prepare(
         `DELETE FROM trip_emergency_contacts
         WHERE trip_id = ?
           AND (
             id = ?
             OR (origin = 'ai' AND managed_by = 'ai' AND semantic_key = ?)
           )`,
      ).bind(tripId, id, aiIdentity.semanticKey);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trip_note_ai_exclusions
           (trip_id, doc_type, semantic_key, label, deleted_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trip_id, doc_type, semantic_key)
         DO UPDATE SET label = excluded.label,
                       deleted_by = excluded.deleted_by,
                       deleted_at = datetime('now')`,
      ).bind(
        tripId,
        aiIdentity.docType,
        aiIdentity.semanticKey,
        aiIdentity.label,
        auth.email,
      ),
      deleteStatement,
    ]);
    excluded = true;
  } else {
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  }

  // PR26: audit log for delete
  await logAudit(env.DB, {
    tripId,
    tableName: table,
    recordId: id,
    action: 'delete',
    changedBy: auth.email,
    diffJson: JSON.stringify(oldRow),
  });

  return json({ ok: true, excluded });
}

// ============================================================================
// REORDER — bulk update sort_order for N rows in one trip
// body: { items: [{ id, sortOrder }, ...] }
// 所有 id 必須屬於同 trip + 同 table，atomicity 走 batch (D1 supports prepare batch)
// ============================================================================

export async function reorderNotesRows(
  context: EventContext<Env, string, Record<string, unknown>>,
  table: NotesTable,
): Promise<Response> {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;

  await requireTripWrite(env.DB, auth, tripId);

  const body = await parseJsonBody<{ items?: Array<{ id?: number; sortOrder?: number }> }>(context.request);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) throw new AppError('DATA_VALIDATION', 'items 必須是非空陣列');

  // 驗 input 型別
  for (const it of items) {
    if (typeof it.id !== 'number' || !Number.isInteger(it.id) || it.id <= 0) {
      throw new AppError('DATA_VALIDATION', `id 必須是正整數，得到 ${JSON.stringify(it.id)}`);
    }
    if (typeof it.sortOrder !== 'number' || !Number.isInteger(it.sortOrder) || it.sortOrder < 0) {
      throw new AppError('DATA_VALIDATION', `sortOrder 必須是非負整數`);
    }
  }

  // 一次 SELECT 確認所有 id 都屬於該 trip（防越權）
  const ids = items.map((it) => it.id!);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) throw new AppError('DATA_VALIDATION', 'items 不可包含重複 id');
  const placeholders = ids.map(() => '?').join(', ');
  const { results: existing } = await env.DB
    .prepare(`SELECT id FROM ${table} WHERE trip_id = ? AND id IN (${placeholders})`)
    .bind(tripId, ...ids)
    .all<{ id: number }>();
  if ((existing?.length ?? 0) !== ids.length) {
    throw new AppError('PERM_DENIED', '部分 id 不屬於該 trip 或不存在');
  }

  // Batch UPDATE — D1 batch atomic
  const stmts = items.map((it) =>
    env.DB
      .prepare(`UPDATE ${table} SET sort_order = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(it.sortOrder, it.id),
  );
  await env.DB.batch(stmts);

  // PR26: audit log for reorder — recordId=null + action='update' + 摘要 diff（bulk 不寫 per-row 噪音）
  await logAudit(env.DB, {
    tripId,
    tableName: table,
    recordId: null,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({ op: 'reorder', items: items.map((it) => ({ id: it.id, sortOrder: it.sortOrder })) }),
  });

  return json({ ok: true, updated: items.length });
}

// ============================================================================
// Validation helper — enum check
// ============================================================================

function validateEnums(table: NotesTable, body: Record<string, unknown>) {
  const kindEnum = KIND_ENUMS[table];
  if (kindEnum && 'kind' in body && typeof body.kind === 'string') {
    if (!(kindEnum as readonly string[]).includes(body.kind)) {
      throw new AppError('DATA_VALIDATION', `kind 必須是 ${kindEnum.join('/')} 之一`);
    }
  }
  if (table === 'trip_pretrip_notes' && 'ai_source' in body && body.ai_source !== null) {
    if (typeof body.ai_source !== 'string' || !(AI_SOURCE_ENUM as readonly string[]).includes(body.ai_source)) {
      throw new AppError('DATA_VALIDATION', `ai_source 必須是 ${AI_SOURCE_ENUM.join('/')} 之一或 null`);
    }
  }
}
