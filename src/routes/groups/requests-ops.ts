import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as backfillStatusGet } from '../handlers/admin/backfill-status';
import { onRequestPost as cacheCleanupPost } from '../handlers/admin/cache-cleanup';
import { onRequestPost as mapsLockPost } from '../handlers/admin/maps-lock';
import { onRequestGet as mapsSettingsGet } from '../handlers/admin/maps-settings';
import { onRequestPost as mapsUnlockPost } from '../handlers/admin/maps-unlock';
import { onRequestGet as poisDueRefreshGet } from '../handlers/admin/pois-due-refresh';
import { onRequestGet as poisPendingPlaceIdGet } from '../handlers/admin/pois-pending-place-id';
import { onRequestGet as quotaEstimateGet } from '../handlers/admin/quota-estimate';
import { onRequestPost as reportsPost } from '../handlers/reports';
import { onRequestGet as requestsGet, onRequestPost as requestsPost } from '../handlers/requests';
import { onRequestGet as requestByIdGet, onRequestPatch as requestByIdPatch } from '../handlers/requests/@id/index';

/**
 * requests／reports／admin（維運）路由。
 * - admin 端點一律 auth: 'required'，handler 內再用 requireScope 檢查 ops:* scope（沒有全域 admin）。
 * - POST /api/reports 是公開端點（使用者錯誤回報，舊 middleware 明列的 bypass）。
 * - GET /api/health 已由 src/health.ts 提供（回應形狀與舊 handler 相同，沿用既有測試），這裡不重複登記。
 * - requests/:id/events（SSE）不在此組，見 routes/request-events.ts。
 */
export function registerRequestsOpsRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/requests', auth: 'required', handler: requestsGet, summary: '請求列表' });
  legacyRoute(app, { method: 'post', path: '/api/requests', auth: 'required', handler: requestsPost, summary: '建立請求' });
  legacyRoute(app, { method: 'get', path: '/api/requests/:id', auth: 'required', handler: requestByIdGet, summary: '單筆請求' });
  legacyRoute(app, { method: 'patch', path: '/api/requests/:id', auth: 'required', handler: requestByIdPatch, summary: '更新請求（companion／寫權限 gate）' });

  legacyRoute(app, { method: 'post', path: '/api/reports', auth: 'none', handler: reportsPost, summary: '使用者錯誤回報（公開）' });

  legacyRoute(app, { method: 'get', path: '/api/admin/backfill-status', auth: 'required', handler: backfillStatusGet, summary: 'ops:poi' });
  legacyRoute(app, { method: 'post', path: '/api/admin/cache-cleanup', auth: 'required', handler: cacheCleanupPost, summary: 'ops:cache' });
  legacyRoute(app, { method: 'post', path: '/api/admin/maps-lock', auth: 'required', handler: mapsLockPost, summary: 'ops:maps' });
  legacyRoute(app, { method: 'get', path: '/api/admin/maps-settings', auth: 'required', handler: mapsSettingsGet, summary: 'ops:maps' });
  legacyRoute(app, { method: 'post', path: '/api/admin/maps-unlock', auth: 'required', handler: mapsUnlockPost, summary: 'ops:maps' });
  legacyRoute(app, { method: 'get', path: '/api/admin/pois-due-refresh', auth: 'required', handler: poisDueRefreshGet, summary: 'ops:poi' });
  legacyRoute(app, { method: 'get', path: '/api/admin/pois-pending-place-id', auth: 'required', handler: poisPendingPlaceIdGet, summary: 'ops:poi' });
  legacyRoute(app, { method: 'get', path: '/api/admin/quota-estimate', auth: 'required', handler: quotaEstimateGet, summary: 'ops:maps' });
}
