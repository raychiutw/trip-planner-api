/**
 * GET /api/my-trips — 回傳使用者有權限的 trip 摘要
 *
 * v2.22.1: 加 name / title / totalDays 給 AddPoiFavoriteToTripPage dropdown 顯示
 *   trip 名稱用（之前只回 tripId，dropdown 看到「選擇行程…」之後 options 空白）。
 *   totalDays 從 trip_days COUNT subquery 算。Backwards-compatible：既有 callers
 *   只 read tripId 仍 work。
 *
 * 2026-06: 加 trip card meta 富欄位給 Flutter client 顯示行程卡 / filter / 排序。
 *   仿 trips.ts baseCols（line ~192）的富欄位 SELECT。全部用 camelCase alias，
 *   對齊既有 tripId / name / title / totalDays 風格。Additive / backwards-compatible：
 *   web AddPoiFavoriteToTripPage 只 read tripId / name / title / totalDays，新欄位
 *   不影響既有 callers。
 *   新增欄位：
 *     - owner            （u.email — V2 cutover 後 trips.owner email column 已 drop，
 *                          LEFT JOIN users 拿 owner email for display）
 *     - ownerDisplayName （u.display_name — trip card avatar initial / 顯示名）
 *     - ownerUserId      （t.owner_user_id — canonical owner id）
 *     - role             （p.role — 當前 user 在此 trip 的權限：owner/member/viewer。
 *                          Phase 3：移除全域 admin，純列出 user 有 permission row 的 trip）
 *     - countries        （t.countries — filter / 顯示）
 *     - startDate        （MIN(trip_days.date) — 行程起日）
 *     - endDate          （MAX(trip_days.date) — 行程迄日）
 *     - updatedAt        （t.updated_at — 排序 / 同步用；trips 表確有此欄位 migration 0047）
 *     - memberCount      （COUNT(DISTINCT trip_permissions.user_id) — 協作人數）
 *     - archivedAt       （trips.archived_at — owner-controlled, trip-wide list classification）
 */

import { requireAuth } from '../../lib/permissions';
import { json } from '../../lib/utils';
import type { Env } from '../../env';

// LEFT JOIN users u ON u.id = t.owner_user_id：V2 cutover (migration 0047) 後
// trips.owner email column 已 drop，owner_user_id 為 canonical，需 JOIN users 拿
// email / display_name 顯示。（Phase 3 移除全域 admin 後僅 user 自己的行程查詢用此 SELECT_BASE）
const SELECT_BASE = `
  SELECT DISTINCT
    p.trip_id AS tripId,
    t.name AS name,
    t.title AS title,
    u.email AS owner,
    u.display_name AS ownerDisplayName,
    t.owner_user_id AS ownerUserId,
    p.role AS role,
    t.countries AS countries,
    t.updated_at AS updatedAt,
    t.archived_at AS archivedAt,
    COALESCE((SELECT COUNT(*) FROM trip_days td WHERE td.trip_id = t.id), 0) AS totalDays,
    (SELECT MIN(date) FROM trip_days td WHERE td.trip_id = t.id AND date IS NOT NULL) AS startDate,
    (SELECT MAX(date) FROM trip_days td WHERE td.trip_id = t.id AND date IS NOT NULL) AS endDate,
    (SELECT COUNT(DISTINCT user_id) FROM trip_permissions mp WHERE mp.trip_id = t.id) AS memberCount
  FROM trip_permissions p
  INNER JOIN trips t ON t.id = p.trip_id
  LEFT JOIN users u ON u.id = t.owner_user_id
`;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const auth = requireAuth(context);

  // INNER JOIN trips so orphan permission rows (trip deleted but permission left
  // behind) never leak into /trips landing or ManagePage trip selector.
  // V2 cutover phase 2: 純 user_id-keyed query (email column dropped, '*' wildcard 也走了)
  // Phase 3（移除全域 admin）：無 admin 看全部分支，純 owner/member 自己的 trip。
  if (!auth.userId) return json([]);
  // v2.55.56: 受限 token（tp-request downscope）只看自己那個 trip — 這是唯一 Bearer 可達
  // 的多-trip list 端點，不加過濾會讓被注入的 agent 列舉 owner 其他 trip（confused-deputy
  // 偵察面）。內容 gate 只在 per-trip 端點，list 端點得自己 scope。
  const scoped = auth.restrictTrip !== undefined;
  const { results } = await (scoped
    ? env.DB.prepare(`${SELECT_BASE} WHERE p.user_id = ? AND p.trip_id = ? ORDER BY t.updated_at DESC, p.trip_id`)
        .bind(auth.userId, auth.restrictTrip)
    : env.DB.prepare(`${SELECT_BASE} WHERE p.user_id = ? ORDER BY t.updated_at DESC, p.trip_id`)
        .bind(auth.userId)
  ).all();

  return json(results);
};
