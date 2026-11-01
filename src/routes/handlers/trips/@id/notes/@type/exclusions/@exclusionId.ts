import { requireAuth, requireTripWrite } from '../../../../../../../lib/permissions';
import { logAudit } from '../../../../../../../lib/audit';
import { AppError } from '../../../../../../../errors';
import { isNoteAiDocType } from '../../../../../../../lib/note-ai';
import { json, parseIntParam } from '../../../../../../../lib/utils';
import type { Env } from '../../../../../../../env';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const tripId = context.params.id as string;
  const docType = context.params.type as string;
  const exclusionId = parseIntParam(context.params.exclusionId as string);
  if (!isNoteAiDocType(docType) || !exclusionId) throw new AppError('DATA_VALIDATION');
  await requireTripWrite(context.env.DB, auth, tripId);

  const exclusion = await context.env.DB.prepare(
    `DELETE FROM trip_note_ai_exclusions
     WHERE id = ? AND trip_id = ? AND doc_type = ?
     RETURNING *`,
  ).bind(exclusionId, tripId, docType).first<Record<string, unknown>>();
  if (!exclusion) throw new AppError('DATA_NOT_FOUND');

  await logAudit(context.env.DB, {
    tripId,
    tableName: 'trip_note_ai_exclusions',
    recordId: exclusionId,
    action: 'delete',
    changedBy: auth.email,
    diffJson: JSON.stringify(exclusion),
  });
  return json({ ok: true });
};
