import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as S from '../../schemas/requests-ops';
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
const err = (description: string) => ({ description, schema: ApiError });
const E401 = err('未帶有效 bearer token');
const E403 = err('沒有權限');
const opsScopeErr = (scope: string) => err(`token 不是帶 ${scope} scope 的 service token（使用者 token 一律拒絕）`);

export function registerRequestsOpsRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/requests', auth: 'required', handler: requestsGet, summary: '請求列表', docs: { query: S.Requests_ListQuery, responses: { 200: { description: '沒帶分頁參數回陣列；帶 limit／before／after 回 { items, hasMore }', schema: S.Requests_ListResponse }, 400: err('缺 tripId（且 token 沒有 ops:trips:read）'), 401: E401, 403: E403 } } });
  legacyRoute(app, { method: 'post', path: '/api/requests', auth: 'required', handler: requestsPost, summary: '建立請求', docs: { body: S.Requests_CreateBody, responses: { 201: { description: '已建立', schema: S.Requests_Row }, 200: { description: '30 秒內相同（trip、message、送出者）且仍在 open／processing 的請求去重，回既有資料列', schema: S.Requests_Row }, 400: err('缺 tripId 或 message'), 401: E401, 403: err('對該行程沒有寫權限') } } });
  legacyRoute(app, { method: 'get', path: '/api/requests/:id', auth: 'required', handler: requestByIdGet, summary: '單筆請求', docs: { responses: { 200: { description: '請求資料列（讀取時會順帶收屍逾時的請求）', schema: S.Requests_RowWithName }, 401: E401, 403: err('對該請求所屬行程沒有權限'), 404: err('找不到請求') } } });
  legacyRoute(app, { method: 'patch', path: '/api/requests/:id', auth: 'required', handler: requestByIdPatch, summary: '更新請求（需 companion scope 的 service token，或對該請求所屬行程有寫權限的使用者）', docs: { body: S.Requests_PatchBody, responses: { 200: { description: '更新後的資料列', schema: S.Requests_Row }, 400: err('status／processed_by／terminalReason 值不合法、status 倒退，或沒有任何要更新的欄位'), 401: E401, 403: err('既無 companion scope 也無該行程寫權限'), 404: err('找不到請求') } } });

  legacyRoute(app, { method: 'post', path: '/api/reports', auth: 'none', handler: reportsPost, summary: '使用者錯誤回報（公開，不需認證）', docs: { body: S.Reports_Body, responses: { 201: { description: '已儲存（tripId 不存在時也回 201 但不儲存，避免洩漏行程是否存在）', schema: S.Reports_Ok }, 200: { description: '命中蜜罐欄位：假裝成功、不儲存', schema: S.Reports_Ok }, 400: err('缺 tripId'), 429: err('同行程＋URL 30 秒內重複，或來源 IP 超過頻率限制（code 為 SYS_RATE_LIMIT 或 RATE_LIMITED；後者帶 Retry-After header）') } } });

  legacyRoute(app, { method: 'get', path: '/api/admin/backfill-status', auth: 'required', handler: backfillStatusGet, summary: 'POIs 的 place_id 回填進度（需 ops:poi scope）', docs: { responses: { 200: { description: '回填狀態', schema: S.Admin_BackfillStatus }, 401: E401, 403: opsScopeErr('ops:poi') } } });
  legacyRoute(app, { method: 'post', path: '/api/admin/cache-cleanup', auth: 'required', handler: cacheCleanupPost, summary: '清除過期的 POI 搜尋快取（需 ops:cache scope）', docs: { responses: { 200: { description: '刪除筆數', schema: S.Admin_CacheCleanup }, 401: E401, 403: opsScopeErr('ops:cache') } } });
  legacyRoute(app, { method: 'post', path: '/api/admin/maps-lock', auth: 'required', handler: mapsLockPost, summary: '手動啟用 Google Maps kill switch（需 ops:maps scope）', docs: { body: S.Admin_MapsLockBody, responses: { 200: { description: '已鎖定', schema: S.Admin_MapsLock }, 401: E401, 403: opsScopeErr('ops:maps') } } });
  legacyRoute(app, { method: 'get', path: '/api/admin/maps-settings', auth: 'required', handler: mapsSettingsGet, summary: 'Google Maps kill switch 狀態（需 ops:maps scope）', docs: { responses: { 200: { description: '鎖定狀態', schema: S.Admin_MapsSettings }, 401: E401, 403: opsScopeErr('ops:maps') } } });
  legacyRoute(app, { method: 'post', path: '/api/admin/maps-unlock', auth: 'required', handler: mapsUnlockPost, summary: '手動解除 Google Maps kill switch（需 ops:maps scope）', docs: { responses: { 200: { description: '已解鎖', schema: S.Admin_MapsUnlock }, 401: E401, 403: opsScopeErr('ops:maps') } } });
  legacyRoute(app, { method: 'get', path: '/api/admin/pois-due-refresh', auth: 'required', handler: poisDueRefreshGet, summary: '需要重新整理的 POI 清單（需 ops:poi scope）', docs: { query: S.Admin_LimitQuery, responses: { 200: { description: 'POI 清單', schema: S.Admin_PoisDueRefresh }, 401: E401, 403: opsScopeErr('ops:poi') } } });
  legacyRoute(app, { method: 'get', path: '/api/admin/pois-pending-place-id', auth: 'required', handler: poisPendingPlaceIdGet, summary: '尚無 place_id 的 POI 清單（需 ops:poi scope）', docs: { query: S.Admin_LimitQuery, responses: { 200: { description: 'POI 清單', schema: S.Admin_PoisPendingPlaceId }, 401: E401, 403: opsScopeErr('ops:poi') } } });
  legacyRoute(app, { method: 'get', path: '/api/admin/quota-estimate', auth: 'required', handler: quotaEstimateGet, summary: '本月 Google Maps 各 method 用量（需 ops:maps scope）', docs: { responses: { 200: { description: '各 method 本月至今請求數', schema: S.Admin_QuotaEstimate }, 401: E401, 403: opsScopeErr('ops:maps'), 502: err('Google Cloud Monitoring 無法取得用量（MAPS_UPSTREAM_FAILED）') } } });
}
