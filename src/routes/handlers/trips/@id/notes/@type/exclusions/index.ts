import { hasPermission, requireAuth } from '../../../../../../../lib/permissions';
import { AppError } from '../../../../../../../errors';
import { isNoteAiDocType } from '../../../../../../../lib/note-ai';
import { json } from '../../../../../../../lib/utils';
import type { Env } from '../../../../../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const tripId = context.params.id as string;
  const docType = context.params.type as string;
  if (!isNoteAiDocType(docType)) throw new AppError('DATA_VALIDATION');
  if (!(await hasPermission(context.env.DB, auth, tripId))) throw new AppError('PERM_DENIED');

  const { results } = await context.env.DB.prepare(
    `SELECT id, doc_type, semantic_key, label, deleted_at
     FROM trip_note_ai_exclusions
     WHERE trip_id = ? AND doc_type = ?
     ORDER BY deleted_at DESC, id DESC`,
  ).bind(tripId, docType).all<Record<string, unknown>>();
  return json({ items: results ?? [] });
};
