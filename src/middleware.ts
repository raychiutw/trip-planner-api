/** 全域 middleware：request id、安全標頭、CORS。順序由 createApp 決定（安全標頭最外層，連錯誤與拒絕回應都套得到）。 */
import type { MiddlewareHandler } from 'hono';
import { AppError, errorResponse } from './errors';
import type { Env } from './env';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.header('X-Request-Id', id);
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.res.headers.delete('X-Powered-By');
  c.res.headers.delete('Server');
};

function allowedOrigins(env: Env): Set<string> {
  return new Set((env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type, Idempotency-Key, X-Request-Scope';

/**
 * 白名單內才放行；不在白名單（含 `null`、空字串）→ 403，連 preflight 也一樣。
 * 沒有 Origin（mobile、伺服器對伺服器）→ 直接放行。認證走 bearer，不開 credentials。
 */
export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin === undefined) return next();
  if (!allowedOrigins(c.env).has(origin)) return errorResponse(new AppError('PERM_DENIED'));

  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id');
  if (c.req.method === 'OPTIONS') {
    c.header('Access-Control-Allow-Methods', ALLOW_METHODS);
    c.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
    c.header('Access-Control-Max-Age', '600');
    return c.body(null, 204);
  }
  return next();
};
