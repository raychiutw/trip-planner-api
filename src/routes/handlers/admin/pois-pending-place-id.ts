/**
 * GET /api/admin/pois-pending-place-id?limit=N
 *
 * Returns POIs without place_id (backfill source list). Used by
 * scripts/google-poi-initial-backfill.ts.
 *
 * Auth: admin only.
 *
 * Response: { rows: Array<{ id, name, address, place_id }> }
 *   place_id is always null in response (filter predicate).
 */

import { requireScope } from '../../../lib/permissions';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  requireScope(context, 'ops:poi');
  const url = new URL(context.request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500);

  const { results } = await context.env.DB.prepare(
    `SELECT id, name, address, place_id FROM pois
     WHERE place_id IS NULL
     ORDER BY id
     LIMIT ?`,
  ).bind(limit).all();

  return new Response(JSON.stringify({ rows: results || [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
