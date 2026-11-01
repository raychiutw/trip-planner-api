/**
 * DELETE /api/poi-favorites/:id — 移除收藏
 *
 * 僅允許 owner（resolved userId 相符）刪除；他人 → 403；不存在 → 404。（Phase 3：無 admin bypass）
 *
 * Companion 分支（poi-favorites-rename §8）：
 *   - body { companionRequestId } + header X-Request-Scope: companion
 *   - 走 requireFavoriteActor(action='favorite_delete')：寫 companion_request_actions
 *     UNIQUE 衝突 → 409 COMPANION_QUOTA_EXCEEDED；gate 失敗 → 401
 *   - companion 模式 ownership 用 resolved userId（submitter）比 row.user_id
 *   - 成功刪除寫 audit_log（changedBy='companion:<id>', tripId='system:companion'）
 */
import { AppError } from '../../../errors';
import { logAudit } from '../../../lib/audit';
import { parseIntParam, parseJsonBody } from '../../../lib/utils';
import { assertNotTripRestricted } from '../../../lib/permissions';
import { assertFavoriteOwnership, preGateFavoriteThrottle, requireFavoriteActor } from '../../../lib/companion';
import type { Env, AuthData } from '../../../env';

interface DeleteBody {
  companionRequestId?: number;
}

export const onRequestDelete: PagesFunction<Env, 'id'> = async (context) => {
  const auth = (context.data as { auth?: AuthData }).auth ?? null;
  // restrict_trip token 不可刪跨 trip 的 user 收藏（favorites user-scoped）— containment。
  if (auth) assertNotTripRestricted(auth);
  const id = parseIntParam(context.params.id as string);
  if (!id) throw new AppError('DATA_VALIDATION', 'id 須為正整數');

  // v2.33.105 SEC-2: pre-gate per-IP throttle 在 actor resolve / DB work 之前
  const preGate = await preGateFavoriteThrottle(context.env, context.request);
  if (preGate) return preGate;

  // body 為 optional（V2 user DELETE 通常無 body）。companion 模式需要 companionRequestId。
  let body: DeleteBody | null = null;
  const headerScope = context.request.headers.get('X-Request-Scope');
  if (headerScope === 'companion') {
    body = await parseJsonBody<DeleteBody>(context.request).catch(() => ({} as DeleteBody));
  }

  // resolve effective actor（companion → submitter；V2 user → auth.userId；否則 401）
  const actor = await requireFavoriteActor(context, body, 'favorite_delete');

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

  // v2.33.100 CR-5: V2-user DELETE 也寫 audit (對齊 INSERT 對稱) — 之前只有
  // companion path log，V2-user 刪掉 favorite 無 forensic trail。
  context.waitUntil(
    logAudit(context.env.DB, {
      tripId: actor.isCompanion ? actor.audit.tripId : 'user',
      tableName: 'poi_favorites',
      recordId: id,
      action: 'delete',
      changedBy: actor.isCompanion ? actor.audit.changedBy : (auth?.email ?? 'unknown'),
      ...(actor.isCompanion ? { requestId: actor.requestId } : {}),
    }),
  );

  return new Response(null, { status: 204 });
};
