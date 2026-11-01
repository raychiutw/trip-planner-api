import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as S from '../../schemas/trips-core';
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

const E = {
  badRequest: { description: '資料格式不正確（DATA_VALIDATION）', schema: ApiError },
  unauthorized: { description: '未登入或 token 無效（AUTH_REQUIRED）', schema: ApiError },
  forbidden: { description: '沒有權限（PERM_DENIED）', schema: ApiError },
  notFound: { description: '找不到資料（DATA_NOT_FOUND）', schema: ApiError },
  conflict: { description: '版本或資料衝突', schema: ApiError },
};

/**
 * 這一組的路由登記。
 * 對照舊 _middleware：`GET /api/trips*` 一律 auth=null 放行，由 handler 內的
 * requireTripReadAccess 決定（已發布行程允許匿名）→ GET 登記為 'optional'；寫入類一律 'required'。
 */
export function registerTripsCoreRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, {
    method: 'get', path: '/api/my-trips', auth: 'required', handler: myTripsGet, summary: '我的行程列表',
    docs: { responses: {
      200: { description: '呼叫者有 trip_permissions 的行程摘要（受限 token 只會看到自己那一個行程）', schema: S.Trips_MyTripList },
      401: E.unauthorized,
    } },
  });

  legacyRoute(app, {
    method: 'get', path: '/api/trips', auth: 'optional', handler: tripsGet, summary: '行程列表',
    docs: { query: S.Trips_ListQuery, responses: {
      200: { description: '已發布行程清單（匿名可讀；不含擁有者個資）。`all=1` 且為 `ops:trips:read` service token 時含未發布', schema: S.Trips_TripList },
      401: { description: '帶了無效的 bearer（不會降級成匿名）', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/trips', auth: 'required', handler: tripsPost, summary: '建立行程',
    docs: { body: S.Trips_CreateBody, responses: {
      201: { description: '建立成功；行程 ID 由伺服器產生，請讀回應的 tripId', schema: S.Trips_CreateResult },
      400: E.badRequest,
      401: E.unauthorized,
      403: { description: '受限 token（tp-request downscope）不可建立行程', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/trips/import', auth: 'required', handler: importPost, summary: '匯入行程',
    docs: { body: S.Trips_ImportBody, responses: {
      201: { description: '匯入成功，建立一個新行程', schema: S.Trips_ImportResult },
      400: { description: '檔案過大（512KB）、不是 JSON、格式版本不符、內容超過上限、缺名稱，或行程數已達上限', schema: ApiError },
      401: E.unauthorized,
      403: { description: '受限 token 不可匯入', schema: ApiError },
    } },
  });

  legacyRoute(app, {
    method: 'get', path: '/api/trips/:id', auth: 'optional', handler: tripGet, summary: '讀取行程',
    docs: { responses: {
      200: { description: '行程本體與目的地。已發布行程可匿名讀；未發布需為成員', schema: S.Trips_Trip },
      401: { description: '帶了無效的 bearer', schema: ApiError },
      403: { description: '未發布且呼叫者不是成員（匿名亦同），或 token scope／受限行程不符', schema: ApiError },
      404: E.notFound,
    } },
  });
  legacyRoute(app, {
    method: 'put', path: '/api/trips/:id', auth: 'required', handler: tripPut, summary: '更新行程',
    docs: { body: S.Trips_UpdateBody, responses: {
      200: { description: '更新成功', schema: S.Trips_Ok },
      400: { description: 'lang／data_source 不合法、destinations 超過 30 筆、或沒有任何可更新的欄位', schema: ApiError },
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限（viewer、非成員、scope 不足皆是）', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/trips/:id', auth: 'required', handler: tripDelete, summary: '刪除行程',
    docs: { responses: {
      200: { description: '已刪除（相關資料以 FK cascade 清除）', schema: S.Trips_Ok },
      401: E.unauthorized,
      403: { description: '僅行程擁有者可刪除；受限 token 不可刪除', schema: ApiError },
      404: E.notFound,
    } },
  });

  legacyRoute(app, {
    method: 'put', path: '/api/trips/:id/archive', auth: 'required', handler: archivePut, summary: '封存行程',
    docs: { responses: {
      200: { description: '已封存（已封存則維持原封存時間）', schema: S.Trips_ArchiveResult },
      401: E.unauthorized,
      403: { description: '僅擁有者可封存；受限 token 或缺 trips:write scope 不可', schema: ApiError },
      404: E.notFound,
    } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/trips/:id/archive', auth: 'required', handler: archiveDelete, summary: '取消封存',
    docs: { responses: {
      200: { description: '已取消封存（archivedAt 為 null）', schema: S.Trips_ArchiveResult },
      401: E.unauthorized,
      403: { description: '僅擁有者可取消封存；受限 token 或缺 trips:write scope 不可', schema: ApiError },
      404: E.notFound,
    } },
  });

  legacyRoute(app, {
    method: 'get', path: '/api/trips/:id/audit', auth: 'required', handler: auditGet, summary: '行程稽核紀錄',
    docs: { query: S.Trips_AuditQuery, responses: {
      200: { description: '稽核紀錄（最新在前）。註冊為 optional，但 handler 一律要求登入，匿名會得到 401', schema: S.Trips_AuditList },
      400: E.badRequest,
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/trips/:id/audit/:aid/rollback', auth: 'required', handler: rollbackPost, summary: '還原稽核紀錄',
    docs: { responses: {
      200: { description: '已還原；rolledBack 表示做了哪一種還原', schema: S.Trips_RollbackResult },
      400: { description: '資料表不在白名單、快照／diff 缺漏或格式無效、欄位不在白名單', schema: ApiError },
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限', schema: ApiError },
      404: E.notFound,
      409: { description: '無法回滾：delete 還原時該 ID 的記錄已存在', schema: ApiError },
    } },
  });

  legacyRoute(app, {
    method: 'get', path: '/api/trips/:id/health-check', auth: 'required', handler: healthCheckGet, summary: '行程健檢結果',
    docs: { responses: {
      200: { description: '最新的 AI 健檢報告；尚未健檢時 report 為 null。註冊為 optional，但 handler 一律要求登入', schema: S.Trips_HealthCheckResult },
      401: E.unauthorized,
      403: { description: '沒有此行程的讀取權限', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/trips/:id/health-check', auth: 'required', handler: healthCheckPost, summary: '觸發行程健檢',
    docs: { responses: {
      200: { description: '30 秒內已有 pending 的健檢，直接回傳該報告（未建立新的）', schema: S.Trips_HealthCheckTriggerResult },
      202: { description: '已建立新的健檢請求（pending），結果非同步產生', schema: S.Trips_HealthCheckTriggerResult },
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限', schema: ApiError },
      422: { description: '行程沒有任何景點（TRIP_EMPTY）', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/trips/:id/health', auth: 'required', handler: healthGet, summary: '行程健康度',
    docs: { responses: {
      200: { description: '歇業／缺漏 POI 摘要。回應鍵名為 snake_case（裸 Response，不經 camelCase 轉換）。註冊為 optional，但 handler 一律要求登入', schema: S.Trips_TripHealth },
      401: E.unauthorized,
      403: { description: '沒有此行程的讀取權限', schema: ApiError },
    } },
  });

  legacyRoute(app, {
    method: 'post', path: '/api/trips/:id/recompute-travel', auth: 'required', handler: recomputePost, summary: '重算交通',
    docs: { query: S.Trips_RecomputeQuery, responses: {
      200: { description: '重算完成（個別段落失敗記在 errorsDetail，不影響整體 200）', schema: S.Trips_RecomputeResult },
      400: E.badRequest,
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限', schema: ApiError },
      502: { description: '伺服器未設定 GOOGLE_MAPS_API_KEY（MAPS_UPSTREAM_FAILED）', schema: ApiError },
      503: { description: '本月 Google API 配額已用完（MAPS_LOCKED）', schema: ApiError },
    } },
  });

  legacyRoute(app, {
    method: 'get', path: '/api/trips/:id/segments', auth: 'optional', handler: segmentsGet, summary: '交通段列表',
    docs: { responses: {
      200: { description: '行程所有交通段（依天數與景點順序）。已發布行程可匿名讀', schema: S.Trips_SegmentList },
      401: { description: '帶了無效的 bearer', schema: ApiError },
      403: { description: '未發布且呼叫者不是成員，或 token scope／受限行程不符', schema: ApiError },
      404: E.notFound,
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/trips/:id/segments', auth: 'required', handler: segmentsPost, summary: '新增交通段',
    docs: { body: S.Trips_SegmentCreateBody, responses: {
      201: { description: '建立（或 upsert）後的交通段', schema: S.Trips_Segment },
      400: { description: 'entry id 不合法、from／to 相同、mode 不合法、min 超界或缺 min', schema: ApiError },
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限', schema: ApiError },
      404: { description: 'from／to entry 不屬於此行程', schema: ApiError },
    } },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/trips/:id/segments/:sid', auth: 'required', handler: segmentPatch, summary: '更新交通段',
    docs: { body: S.Trips_SegmentPatchBody, responses: {
      200: { description: '更新後的交通段', schema: S.Trips_Segment },
      400: { description: 'sid 不合法、mode 不合法、min 超界或缺 min', schema: ApiError },
      401: E.unauthorized,
      403: { description: '沒有此行程的寫入權限', schema: ApiError },
      404: { description: '找不到此 segment（或不屬於該行程）', schema: ApiError },
      409: { description: 'expectedVersion 與目前版本不符（STALE_ENTRY）', schema: ApiError },
    } },
  });
}
