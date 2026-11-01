import { hasPermission, requireAuth } from '../../../../../lib/permissions';
import { AppError } from '../../../../../errors';
import { NOTE_AI_DOC_TYPES } from '../../../../../lib/note-ai';
import { expireNoteAiJobs } from '../../../../../lib/request-termination';
import { json } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const tripId = context.params.id as string;
  const db = context.env.DB;
  if (!(await hasPermission(db, auth, tripId))) throw new AppError('PERM_DENIED');

  await expireNoteAiJobs(db, tripId);
  const exclusions = await db.prepare(
    `SELECT doc_type, COUNT(*) AS count
     FROM trip_note_ai_exclusions WHERE trip_id = ? GROUP BY doc_type`,
  ).bind(tripId).all<{ doc_type: string; count: number }>();
  const exclusionCounts = new Map(
    (exclusions.results ?? []).map((row) => [row.doc_type, row.count]),
  );

  const jobs = await Promise.all(NOTE_AI_DOC_TYPES.map(async (docType) => {
    const row = await db.prepare(
      `SELECT * FROM trip_note_ai_jobs
       WHERE trip_id = ? AND doc_type = ?
       ORDER BY generation DESC, id DESC LIMIT 1`,
    ).bind(tripId, docType).first<Record<string, unknown>>();
    return {
      doc_type: docType,
      status: row?.status === 'timed_out' ? 'timedOut' : (row?.status ?? 'idle'),
      job_id: row?.id ?? null,
      request_id: row?.request_id ?? null,
      generation: row?.generation ?? 0,
      inserted_count: row?.inserted_count ?? 0,
      replaced_count: row?.replaced_count ?? 0,
      preserved_manual_count: row?.preserved_manual_count ?? 0,
      duplicate_excluded_count: row?.duplicate_excluded_count ?? 0,
      suppressed_count: row?.suppressed_count ?? 0,
      error_code: row?.error_code ?? null,
      error_message: row?.error_message ?? null,
      created_at: row?.created_at ?? null,
      started_at: row?.started_at ?? null,
      timeout_at: row?.timeout_at ?? null,
      completed_at: row?.completed_at ?? null,
      exclusion_count: exclusionCounts.get(docType) ?? 0,
    };
  }));

  return json({ jobs });
};
