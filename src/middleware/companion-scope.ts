/**
 * Companion 路徑白名單（自舊 _middleware.ts 搬來）。
 *
 * tp-request scheduler 帶 `X-Request-Scope: companion` 時，只允許下列 method+path，
 * 防止 prompt injection 把權限升級成任意寫入。這只是「自我設限」的粗篩；
 * 真正的 gate（OAuth scope + clientId）在各 handler 的 requireFavoriteActor 等 helper。
 */
import type { MiddlewareHandler } from 'hono';
import { AppError, errorResponse } from '../errors';
import type { AppEnv } from '../env';

export const COMPANION_ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/api\/trips\/[^/]+\/days\/\d+\/entries$/ },
  { method: 'PATCH', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+\/alternates$/ },
  { method: 'DELETE', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+\/alternates\/\d+$/ },
  { method: 'PATCH', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+\/alternates\/reorder$/ },
  { method: 'PATCH', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+\/master$/ },
  { method: 'PUT', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+\/poi-id$/ },
  { method: 'POST', pattern: /^\/api\/trips\/[^/]+\/recompute-travel$/ },
  { method: 'POST', pattern: /^\/api\/pois\/\d+\/enrich$/ },
  { method: 'POST', pattern: /^\/api\/trips\/[^/]+\/entries\/\d+\/trip-pois$/ },
  { method: 'PATCH', pattern: /^\/api\/trips\/[^/]+\/trip-pois\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/trips\/[^/]+\/trip-pois\/\d+$/ },
  // PUT /docs 刻意不在名單內（trip_docs 已退役；筆記的正解是 POST /trips/:id/notes/:type/generate）。
  { method: 'PATCH', pattern: /^\/api\/requests\/\d+$/ },
  { method: 'PATCH', pattern: /^\/api\/pois\/\d+$/ },
  { method: 'GET', pattern: /^\/api\/trips\// },
  { method: 'GET', pattern: /^\/api\/requests/ },
  { method: 'GET', pattern: /^\/api\/poi-favorites$/ },
  { method: 'POST', pattern: /^\/api\/poi-favorites$/ },
  { method: 'DELETE', pattern: /^\/api\/poi-favorites\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/poi-favorites\/\d+\/add-to-trip$/ },
];

/** 違規回 403 Response；通過（或不是 companion）回 null。 */
export function companionViolation(request: Request): Response | null {
  if (request.headers.get('X-Request-Scope') !== 'companion') return null;
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  if (COMPANION_ALLOWED.some((r) => r.method === method && r.pattern.test(path))) return null;
  return errorResponse(new AppError('PERM_DENIED', '此操作超出旅伴請求範圍'));
}

export const companionScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const denied = companionViolation(c.req.raw);
  if (denied) return denied;
  await next();
};
