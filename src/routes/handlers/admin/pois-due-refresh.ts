/**
 * GET /api/admin/pois-due-refresh?limit=N
 *
 * Returns active POIs whose last_refreshed_at is NULL or older than 30 days.
 * Used by scripts/google-poi-refresh-30d.ts to feed Place Details refresh.
 *
 * Query design (autoplan T8 fix):
 *   - Only `place_id IS NOT NULL` (skip pre-backfill rows handled separately)
 *   - Only `status='active'` (closed/missing skipped — user can manual re-check)
 *   - `last_refreshed_at IS NULL OR < datetime('now','-30 days')` — covers
 *     newly-created POIs that have never been refreshed yet.
 *   - ORDER BY last_refreshed_at ASC NULLS FIRST so oldest are processed first.
 *
 * Auth: admin only.
 *
 * Response: { rows: Array<{ id, name, place_id, last_refreshed_at }> }
 */

import { requireScope } from '../../../lib/permissions';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  requireScope(context, 'ops:poi');
  const url = new URL(context.request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);

  const { results } = await context.env.DB.prepare(
    `SELECT id, name, place_id, last_refreshed_at FROM pois
     WHERE place_id IS NOT NULL
       AND status = 'active'
       AND (last_refreshed_at IS NULL OR last_refreshed_at < datetime('now', '-30 days'))
     ORDER BY last_refreshed_at ASC
     LIMIT ?`,
  ).bind(limit).all();

  return new Response(JSON.stringify({ rows: results || [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
