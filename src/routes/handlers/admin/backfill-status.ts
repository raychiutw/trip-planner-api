/**
 * GET /api/admin/backfill-status
 *
 * Used by daily-check to detect "migration deployed but backfill never ran" silent
 * failure (autoplan T8 fix). Daily-check Telegrams alert if pending > 0 AND
 * migration_applied_at > 24h ago.
 *
 * Auth: admin only.
 *
 * Response shape (locked-in contract per autoplan DX fix):
 *   {
 *     "version": 1,
 *     "pending": N,                // pois with NULL place_id (still need backfill)
 *     "completed": N,              // pois with non-NULL place_id
 *     "total": N,                  // pending + completed
 *     "migration_applied_at": ISO timestamp | null,
 *     "last_backfill_run_at": ISO timestamp | null
 *   }
 */

import { requireScope } from '../../../lib/permissions';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  requireScope(context, 'ops:poi');

  const db = context.env.DB;

  // Single SQL: aggregate status counts + read sentinel rows.
  const [counts, sentinel] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN place_id IS NULL THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN place_id IS NOT NULL THEN 1 ELSE 0 END) AS completed
         FROM pois`,
      )
      .first<{ pending: number; completed: number }>(),
    db
      .prepare(
        `SELECT key, value FROM app_settings
         WHERE key IN ('google_maps_migration_applied_at', 'google_maps_last_backfill_run_at')`,
      )
      .all<{ key: string; value: string }>(),
  ]);

  const map = new Map((sentinel.results || []).map((r) => [r.key, r.value]));
  const pending = counts?.pending || 0;
  const completed = counts?.completed || 0;

  return new Response(
    JSON.stringify({
      version: 1,
      pending,
      completed,
      total: pending + completed,
      migration_applied_at: map.get('google_maps_migration_applied_at') || null,
      last_backfill_run_at: map.get('google_maps_last_backfill_run_at') || null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
