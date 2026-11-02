/**
 * DELETE /api/poi-favorites/:id — 移除收藏
 *
 * 僅允許 owner（auth.userId 相符）刪除；他人 → 403；不存在 → 404。（Phase 3：無 admin bypass）
 */
import { AppError } from '../../../errors';
import { logAudit } from '../../../lib/audit';
import { parseIntParam } from '../../../lib/utils';
import { assertNotTripRestricted } from '../../../lib/permissions';
import { assertFavoriteOwnership, preGateFavoriteThrottle, requireFavoriteActor } from '../../../lib/favorite-actor';
import type { Env, AuthData } from '../../../env';

export const onRequestDelete: PagesFunction<Env, 'id'> = async (context) => {
  const auth = (context.data as { auth?: AuthData }).auth ?? null;
  // restrict_trip token 不可刪跨 trip 的 user 收藏（favorites user-scoped）— containment。
  if (auth) assertNotTripRestricted(auth);
  const id = parseIntParam(context.params.id as string);
  if (!id) throw new AppError('DATA_VALIDATION', 'id 須為正整數');

  // v2.33.105 SEC-2: pre-gate per-IP throttle 在 actor resolve / DB work 之前
  const preGate = await preGateFavoriteThrottle(context.env, context.request);
  if (preGate) return preGate;

  // resolve actor（V2 user → auth.userId；否則 401）
  const actor = requireFavoriteActor(context);

  const row = await context.env.DB
    .prepare('SELECT user_id, deleted_at FROM poi_favorites WHERE id = ?')
    .bind(id)
    .first<{ user_id: string | null; deleted_at: string | null }>();
  if (!row) throw new AppError('DATA_NOT_FOUND', '找不到該收藏');

  assertFavoriteOwnership(actor, row.user_id);

  // 已取消 → idempotent（spec §2.1）：直接回 204，不重複 soft-delete / audit。
  if (row.deleted_at !== null) {
    return new Response(null, { status: 204 });
  }

  // Soft delete（改自 hard DELETE）：寫 deleted_at tombstone，保留 id/poi_id/note/favorited_at
  // 供 10 分鐘內 restore。AND deleted_at IS NULL 防競速重複 soft-delete。
  // 不動 POI / trip_entry_pois / 其他 user 收藏（spec §2.1）。
  await context.env.DB
    .prepare("UPDATE poi_favorites SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .run();

  // v2.33.100 CR-5: V2-user DELETE 寫 audit（forensic trail）。
  context.waitUntil(
    logAudit(context.env.DB, {
      tripId: 'user',
      tableName: 'poi_favorites',
      recordId: id,
      action: 'delete',
      changedBy: auth?.email ?? 'unknown',
    }),
  );

  return new Response(null, { status: 204 });
};
