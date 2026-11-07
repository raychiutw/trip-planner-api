/**
 * GET /api/admin/pois-pending-place-id?limit=N&after_id=M
 *
 * Returns POIs without place_id (backfill source list). Used by
 * scripts/google-poi-initial-backfill.ts.
 *
 * Auth: admin only.
 *
 * after_id：只回 id 大於該值的列（id 升冪游標，回填工具以最後一筆 id 續抓）。
 *
 * Response: { rows: Array<{ id, name, address, lat, lng, place_id }> }
 *   lat／lng 無座標時為 null。
 *   place_id is always null in response (filter predicate).
 */

import { requireScope } from '../../../lib/permissions';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  requireScope(context, 'ops:poi');
  const url = new URL(context.request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500);

  const afterId = Math.max(parseInt(url.searchParams.get('after_id') || '0', 10) || 0, 0);

  const { results } = await context.env.DB.prepare(
    `SELECT id, name, address, lat, lng, place_id FROM pois
     WHERE place_id IS NULL AND id > ?
     ORDER BY id
     LIMIT ?`,
  ).bind(afterId, limit).all();

  return new Response(JSON.stringify({ rows: results || [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
