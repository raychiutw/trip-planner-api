/**
 * GET /api/account/stats — Account hub Profile hero 3 stats aggregate
 *
 * Section 2 (terracotta-account-hub-page Requirement 2)：mockup line
 * 7437-7448 規範 hero「N 個行程 / N 天旅程 / N 位旅伴」三 stats，避免 client
 * 端 N+1 fetch。
 *
 * V2 cutover phase 2: 純 user_id-keyed query (email column dropped)。
 */
import { requireAuth } from '../../../lib/permissions';
import { json } from '../../../lib/utils';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  if (!auth.userId) {
    return json({ tripCount: 0, totalDays: 0, collaboratorCount: 0 });
  }
  const db = context.env.DB;
  const userId = auth.userId;

  // 兩個 query 互不相依，平行 fetch 省 DB roundtrip
  const [tripStats, collabStats] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(DISTINCT t.id) AS trip_count,
                COALESCE(SUM(day_counts.day_count), 0) AS total_days
         FROM trips t
         INNER JOIN trip_permissions tp ON tp.trip_id = t.id
         LEFT JOIN (
           SELECT trip_id, COUNT(*) AS day_count
           FROM trip_days
           GROUP BY trip_id
         ) day_counts ON day_counts.trip_id = t.id
         WHERE tp.user_id = ?`,
      )
      .bind(userId)
      .first<{ trip_count: number; total_days: number }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT tp2.user_id) AS collab_count
         FROM trip_permissions tp1
         INNER JOIN trip_permissions tp2 ON tp1.trip_id = tp2.trip_id
         WHERE tp1.user_id = ? AND tp2.user_id != ?`,
      )
      .bind(userId, userId)
      .first<{ collab_count: number }>(),
  ]);

  return json({
    tripCount: tripStats?.trip_count ?? 0,
    totalDays: tripStats?.total_days ?? 0,
    collaboratorCount: collabStats?.collab_count ?? 0,
  });
};
