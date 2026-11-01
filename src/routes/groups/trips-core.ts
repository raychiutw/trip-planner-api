import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as myTripsGet } from '../handlers/my-trips';

/** 這一組的路由登記（由負責的 agent 填入；見 routes/index.ts 的說明）。 */
export function registerTripsCoreRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/my-trips', auth: 'required', handler: myTripsGet, summary: '我的行程列表' });
}
