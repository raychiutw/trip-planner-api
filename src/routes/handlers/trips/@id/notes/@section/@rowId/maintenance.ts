import { requireAuth, requireTripWrite } from '../../../../../../../lib/permissions';
import { computeDiff, logAudit } from '../../../../../../../lib/audit';
import { AppError } from '../../../../../../../errors';
import { json, parseIntParam, parseJsonBody } from '../../../../../../../lib/utils';
import type { Env } from '../../../../../../../env';
import { getNoteAiIdentity } from '../../_shared';

const TABLES = {
  pretrip: 'trip_pretrip_notes',
  emergency: 'trip_emergency_contacts',
} as const;

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const tripId = context.params.id as string;
  const section = context.params.section as keyof typeof TABLES;
  const rowId = parseIntParam(context.params.rowId as string);
  const table = TABLES[section];
  if (!table || !rowId) throw new AppError('DATA_VALIDATION');
  await requireTripWrite(context.env.DB, auth, tripId);

  const body = await parseJsonBody<{ managedBy?: string; expectedVersion?: number }>(context.request);
  if (body.managedBy !== 'ai' && body.managedBy !== 'human') {
    throw new AppError('DATA_VALIDATION', 'managedBy 必須是 ai 或 human');
  }
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
    throw new AppError('DATA_VALIDATION', 'expectedVersion 必須是非負整數');
  }

  const oldRow = await context.env.DB.prepare(
    `SELECT * FROM ${table} WHERE id = ? AND trip_id = ?`,
  ).bind(rowId, tripId).first<Record<string, unknown>>();
  if (!oldRow) throw new AppError('DATA_NOT_FOUND');
  if (body.managedBy === 'ai' && oldRow.origin !== 'ai') {
    throw new AppError('NOTES_AI_NOT_REASSIGNABLE');
  }
  const aiIdentity = getNoteAiIdentity(table, oldRow);

  const row = await context.env.DB.prepare(
    `UPDATE ${table}
     SET managed_by = ?,
         semantic_key = COALESCE(semantic_key, ?),
         version = version + 1,
         updated_at = datetime('now')
     WHERE id = ? AND trip_id = ? AND version = ?
     RETURNING *`,
  ).bind(
    body.managedBy,
    aiIdentity?.semanticKey ?? null,
    rowId,
    tripId,
    body.expectedVersion,
  ).first<Record<string, unknown>>();
  if (!row) {
    const current = await context.env.DB.prepare(
      `SELECT version FROM ${table} WHERE id = ? AND trip_id = ?`,
    ).bind(rowId, tripId).first<{ version: number }>();
    if (!current) throw new AppError('DATA_NOT_FOUND');
    throw new AppError(
      'STALE_ENTRY',
      `expected version ${body.expectedVersion}, current ${current.version}`,
    );
  }

  await logAudit(context.env.DB, {
    tripId,
    tableName: table,
    recordId: rowId,
    action: 'update',
    changedBy: auth.email,
    diffJson: computeDiff(oldRow, { managed_by: body.managedBy }),
  });
  return json(row);
};
