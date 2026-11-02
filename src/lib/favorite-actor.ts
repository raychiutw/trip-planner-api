/**
 * poi-favorites 共用 helper：actor 解析、per-IP 前置限流、bucket 命名、ownership 檢查。
 *
 * 2026-11-02：companion 分支已移除。`X-Request-Scope: companion` 的請求在全域白名單
 * （src/middleware/companion-scope.ts 的 companionViolation）就被擋下，收藏的 4 個路由不在名單內，
 * 因此 companion 路徑（resolveCompanionUserId／companion_request_actions／companion bucket）不可達。
 * （companion_request_actions 資料表依「migration 只加不刪」保留。）
 */
import { AppError, buildRateLimitResponse } from '../errors';
import { bumpRateLimit, checkRateLimit, clientIp, RATE_LIMITS } from './rate-limit';
import type { Env, AuthData } from '../env';

export interface FavoriteActor {
  /** auth.userId（V2 user） */
  userId: string;
}

/** 收藏端點統一進入點：需 V2 user 身分（auth.userId），否則 401。 */
export function requireFavoriteActor(
  context: EventContext<Env, string, Record<string, unknown>>,
): FavoriteActor {
  const auth = ((context.data as Record<string, unknown>).auth ?? null) as AuthData | null;
  if (!auth?.userId) {
    throw new AppError('AUTH_REQUIRED', '需 V2 OAuth 登入才能操作收藏');
  }
  return { userId: auth.userId };
}

/**
 * v2.33.105 SEC-2: pre-gate per-IP throttle for poi-favorites endpoints。
 *
 * 在 `requireFavoriteActor` 之前呼叫。寬鬆 200/5min/IP — 人類速度遠低於每秒 1 個 favorite write。
 *
 * 回 429 Response（直接帶 Retry-After header）→ caller 直接 return；
 * 回 null 表示通過。
 */
export async function preGateFavoriteThrottle(
  env: Env,
  request: Request,
): Promise<Response | null> {
  const key = `poi-favorites-pre-gate-ip:${clientIp(request)}`;
  const check = await checkRateLimit(env.DB, key, RATE_LIMITS.POI_FAVORITES_PRE_GATE_IP);
  if (!check.ok) {
    return buildRateLimitResponse(check.retryAfter ?? 300, { error: 'RATE_LIMITED' });
  }
  await bumpRateLimit(env.DB, key, RATE_LIMITS.POI_FAVORITES_PRE_GATE_IP);
  return null;
}

/** post-gate bucket：以已驗證的 actor 組 key（`${prefix}:user:${userId}`）。無 admin 豁免。 */
export function pickFavoriteBucketForActor(actor: FavoriteActor, prefix: string): string {
  return `${prefix}:user:${actor.userId}`;
}

/** Ownership gate（DELETE / add-to-trip 共用）：純 owner 檢查，無 admin bypass。 */
export function assertFavoriteOwnership(
  actor: FavoriteActor,
  ownerUserId: string | null,
  detail?: string,
): void {
  if (ownerUserId !== actor.userId) {
    throw new AppError('PERM_DENIED', detail);
  }
}
