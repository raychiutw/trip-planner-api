import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';

/** 這一組的路由登記（由負責的 agent 填入；見 routes/index.ts 的說明）。 */
export function registerRequestsOpsRoutes(_app: OpenAPIHono<AppEnv>): void {
  // 尚未搬移
}
