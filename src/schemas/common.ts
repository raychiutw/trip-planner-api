/** 各路由組共用的 schema（OpenAPI 文件與契約測試共用）。 */
import { z } from '@hono/zod-openapi';

/** 使用者面向端點的巢狀錯誤（見 src/errors.ts）；5xx 不帶 detail。 */
export const ApiError = z.object({
  error: z.object({
    code: z.string().openapi({ example: 'DATA_NOT_FOUND' }),
    message: z.string(),
    detail: z.string().optional(),
  }),
}).openapi('ApiError');
