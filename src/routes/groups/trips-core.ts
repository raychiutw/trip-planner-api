import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as myTripsGet } from '../handlers/my-trips';
import { onRequestGet as tripsGet, onRequestPost as tripsPost } from '../handlers/trips';
import { onRequestGet as tripGet, onRequestPut as tripPut, onRequestDelete as tripDelete } from '../handlers/trips/@id';
import { onRequestPut as archivePut, onRequestDelete as archiveDelete } from '../handlers/trips/@id/archive';
import { onRequestGet as auditGet } from '../handlers/trips/@id/audit';
import { onRequestPost as rollbackPost } from '../handlers/trips/@id/audit/@aid/rollback';
import { onRequestPost as importPost } from '../handlers/trips/import';
import { onRequestGet as healthCheckGet, onRequestPost as healthCheckPost } from '../handlers/trips/@id/health-check';
import { onRequestGet as healthGet } from '../handlers/trips/@id/health';
import { onRequestPost as recomputePost } from '../handlers/trips/@id/recompute-travel';
import { onRequestPatch as segmentPatch } from '../handlers/trips/@id/segments/@sid';
import { onRequestGet as segmentsGet, onRequestPost as segmentsPost } from '../handlers/trips/@id/segments/index';

/**
 * 這一組的路由登記。
 * 對照舊 _middleware：`GET /api/trips*` 一律 auth=null 放行，由 handler 內的
 * requireTripReadAccess 決定（已發布行程允許匿名）→ GET 登記為 'optional'；寫入類一律 'required'。
 */
export function registerTripsCoreRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/my-trips', auth: 'required', handler: myTripsGet, summary: '我的行程列表' });

  legacyRoute(app, { method: 'get', path: '/api/trips', auth: 'optional', handler: tripsGet, summary: '行程列表' });
  legacyRoute(app, { method: 'post', path: '/api/trips', auth: 'required', handler: tripsPost, summary: '建立行程' });
  legacyRoute(app, { method: 'post', path: '/api/trips/import', auth: 'required', handler: importPost, summary: '匯入行程' });

  legacyRoute(app, { method: 'get', path: '/api/trips/:id', auth: 'optional', handler: tripGet, summary: '讀取行程' });
  legacyRoute(app, { method: 'put', path: '/api/trips/:id', auth: 'required', handler: tripPut, summary: '更新行程' });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id', auth: 'required', handler: tripDelete, summary: '刪除行程' });

  legacyRoute(app, { method: 'put', path: '/api/trips/:id/archive', auth: 'required', handler: archivePut, summary: '封存行程' });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/archive', auth: 'required', handler: archiveDelete, summary: '取消封存' });

  legacyRoute(app, { method: 'get', path: '/api/trips/:id/audit', auth: 'optional', handler: auditGet, summary: '行程稽核紀錄' });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/audit/:aid/rollback', auth: 'required', handler: rollbackPost, summary: '還原稽核紀錄' });

  legacyRoute(app, { method: 'get', path: '/api/trips/:id/health-check', auth: 'optional', handler: healthCheckGet, summary: '行程健檢結果' });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/health-check', auth: 'required', handler: healthCheckPost, summary: '觸發行程健檢' });
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/health', auth: 'optional', handler: healthGet, summary: '行程健康度' });

  legacyRoute(app, { method: 'post', path: '/api/trips/:id/recompute-travel', auth: 'required', handler: recomputePost, summary: '重算交通' });

  legacyRoute(app, { method: 'get', path: '/api/trips/:id/segments', auth: 'optional', handler: segmentsGet, summary: '交通段列表' });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/segments', auth: 'required', handler: segmentsPost, summary: '新增交通段' });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/segments/:sid', auth: 'required', handler: segmentPatch, summary: '更新交通段' });
}
