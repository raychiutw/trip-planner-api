import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env';
import { AppError, errorResponse } from './errors';
import { checkHealth, healthRoute } from './health';
import { cors, requestId, securityHeaders } from './middleware';
import { legacyGates } from './middleware/legacy-gates';
import { DEFAULT_SSE_TIMINGS, registerRequestEventsRoutes, type SseTimings } from './routes/request-events';
import { registerOpenApiDocs } from './openapi-docs';
import { registerLegacyRoutes } from './routes';
import { registerLoginRoute } from './routes/login';
import { registerTokenRoute } from './routes/token';

export function createApp(opts: { sse?: Partial<SseTimings> } = {}) {
  const app = new OpenAPIHono<AppEnv>({
    // 驗證失敗：只列欄位路徑，不回傳使用者送來的值（可能是密碼或 token）
    defaultHook: (result) => {
      if (!result.success) {
        const paths = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(body)'))];
        return errorResponse(new AppError('DATA_VALIDATION', `欄位不正確：${paths.join(', ')}`));
      }
    },
  });

  app.use('*', requestId);
  app.use('*', securityHeaders);
  app.use('*', cors);
  app.use('/api/*', legacyGates); // api_logs 紀錄 + companion 路徑白名單
  // Hono 只把 Error 實例交給 onError；丟出字串／物件會直接穿出去。包成 Error 讓它走同一條處理路徑。
  app.use('*', async (_c, next) => {
    try {
      await next();
    } catch (e) {
      throw e instanceof Error ? e : new Error(`non-Error thrown (${typeof e})`);
    }
  });

  app.notFound(() => errorResponse(new AppError('DATA_NOT_FOUND')));

  app.onError((err, c) => {
    const id = c.get('requestId');
    if (err instanceof AppError) {
      if (err.status >= 500) console.error(`[${id}] AppError ${err.code}`, err.detail ?? '', err);
      return errorResponse(err);
    }
    // 畸形 JSON 等 client 錯誤（Hono 以 HTTPException 4xx 表示）
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      return errorResponse(new AppError('DATA_VALIDATION'));
    }
    // 未預期：細節只進 log，回應是通用訊息
    console.error(`[${id}] unhandled`, err);
    return errorResponse(new AppError('SYS_INTERNAL'));
  });

  app.openapi(healthRoute, async (c) => {
    const { code, body } = await checkHealth(c.env);
    return c.json(body, code);
  });

  registerRequestEventsRoutes(app, { ...DEFAULT_SSE_TIMINGS, ...opts.sse });
  registerLoginRoute(app);
  registerLegacyRoutes(app);
  registerTokenRoute(app);

  registerOpenApiDocs(app);

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Tripline API', version: '0.1.0' },
  });

  return app;
}

export const app = createApp();
