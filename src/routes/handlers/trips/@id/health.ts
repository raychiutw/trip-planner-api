/**
 * GET /api/trips/:id/health
 *
 * POI lifecycle health summary for a trip — drives `<TripHealthBanner>`.
 *
 * Auth: trip read permission (viewer / member / owner).
 *
 * Response shape (autoplan DX fix — locked contract):
 *   {
 *     "version": 1,
 *     "closed": N,
 *     "missing": N,
 *     "items": [
 *       { "poi_id": 42, "poi_name": "古都壽司本店", "status": "closed", "reason": "永久歇業" },
 *       ...
 *     ]
 *   }
 *
 * SQL avoids N+1 by single JOIN + filter on status != 'active'.
 * trip_entry_pois → pois — collect distinct canonical entry POIs in this trip.
 *
 * Empty (closed=0 + missing=0) → still returns 200 with items: [].
 * Frontend `<TripHealthBanner>` returns null on empty (does NOT render stub).
 */
import { hasPermission, requireAuth} from '../../../../lib/permissions';
import { AppError } from '../../../../errors';
import type { Env } from '../../../../env';

interface HealthRow {
  poi_id: number;
  poi_name: string;
  status: 'closed' | 'missing';
  reason: string | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const tripId = context.params.id as string;
  if (!tripId) throw new AppError('DATA_VALIDATION', '缺少 tripId');

  const db = context.env.DB;
  if (!(await hasPermission(db, auth, tripId))) {
    throw new AppError('PERM_DENIED');
  }

  const { results } = await db
    .prepare(
      `SELECT DISTINCT
         p.id AS poi_id,
         p.name AS poi_name,
         p.status AS status,
         p.status_reason AS reason
       FROM trip_entry_pois tep
       INNER JOIN trip_entries te ON te.id = tep.entry_id
       INNER JOIN trip_days td    ON td.id = te.day_id
       INNER JOIN pois p          ON p.id = tep.poi_id
       WHERE td.trip_id = ?
         AND p.status != 'active'
       ORDER BY p.id`,
    )
    .bind(tripId)
    .all<HealthRow>();

  const items = results || [];
  let closed = 0;
  let missing = 0;
  for (const r of items) {
    if (r.status === 'closed') closed++;
    else if (r.status === 'missing') missing++;
  }

  return new Response(
    JSON.stringify({ version: 1, closed, missing, items }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Frontend SWR — 60s stale-while-revalidate（POI mutation 後 frontend 主動 invalidate）
        'Cache-Control': 'private, max-age=0, stale-while-revalidate=60',
      },
    },
  );
};
