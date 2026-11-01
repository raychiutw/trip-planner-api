/**
 * 舊 handler 的轉接層（拆分 T12–T14）。
 *
 * 舊入口的 handler 是 Cloudflare Pages Functions：`onRequestGet(context)`，從 context 取
 * request／env／params／data.auth／waitUntil。為了行為不變地搬移約 100 個 handler，
 * 這裡把 Hono 的 context 轉成舊的 context 形狀，handler 原封不動（只改 import 路徑）即可使用；
 * 丟出的 AppError 由全域 onError 轉成與舊入口相同的回應。
 *
 * 路由同時登記進 OpenAPI（路徑、方法、path 參數；請求與回應 schema 之後再逐步補嚴）。
 *
 * 認證模式（對應舊 _middleware 的行為）：
 * - 'required'：沒有有效 bearer → 401（舊 middleware 對非公開路徑的行為）。
 * - 'optional'：有帶就驗（無效 → 401），沒帶 auth=null，由 handler 自己決定（公開讀取但需權限檢查的端點）。
 * - 'none'：完全公開，不看 Authorization，auth 恆為 null。
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bearerAuth, optionalAuth, requireAuth } from './auth';
import type { AppEnv, Env } from './env';

export interface LegacyContext {
  request: Request;
  env: Env;
  params: Record<string, string>;
  data: Record<string, unknown>;
  waitUntil: (p: Promise<unknown>) => void;
  passThroughOnException: () => void;
  functionPath: string;
}

/** 舊 handler 的型別是 PagesFunction（EventContext）；這裡放寬成「接受任何 context」，實際傳入 LegacyContext。 */
export type LegacyHandler = (context: never) => Response | Promise<Response>;
export type AuthMode = 'required' | 'optional' | 'none';
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface LegacyRouteSpec {
  method: HttpMethod;
  /** Hono 風格路徑，例如 `/api/trips/:id/days`。 */
  path: string;
  auth: AuthMode;
  handler: LegacyHandler;
  summary?: string;
}

const MIDDLEWARE: Record<AuthMode, MiddlewareHandler<AppEnv>[]> = {
  required: [bearerAuth, requireAuth],
  optional: [bearerAuth, optionalAuth],
  none: [],
};

/** `/api/trips/:id/days` → `/api/trips/{id}/days`（OpenAPI 的寫法）。 */
const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const paramNames = (p: string) => [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);

export function legacyRoute(app: OpenAPIHono<AppEnv>, spec: LegacyRouteSpec): void {
  const names = paramNames(spec.path);
  const route = createRoute({
    method: spec.method,
    path: toOpenApiPath(spec.path),
    summary: spec.summary,
    middleware: MIDDLEWARE[spec.auth],
    ...(names.length ? { request: { params: z.object(Object.fromEntries(names.map((n) => [n, z.string()]))) } } : {}),
    responses: { 200: { description: 'OK（回應內容依端點而定）', content: { 'application/json': { schema: z.any() } } } },
  });

  app.openapi(route, (async (c: import('hono').Context<AppEnv>) => {
    const pending: Promise<unknown>[] = [];
    const context: LegacyContext = {
      request: c.req.raw,
      env: c.env,
      params: c.req.param() as Record<string, string>,
      data: { auth: spec.auth === 'none' ? null : (c.get('auth') ?? null) },
      waitUntil: (p) => {
        try { c.executionCtx.waitUntil(p); } catch { pending.push(p); } // 沒有 executionCtx（測試）時自己收
      },
      passThroughOnException: () => {},
      functionPath: new URL(c.req.url).pathname,
    };
    const response = await (spec.handler as (c: LegacyContext) => Response | Promise<Response>)(context);
    if (pending.length) await Promise.allSettled(pending);
    return response;
  }) as never);
}
