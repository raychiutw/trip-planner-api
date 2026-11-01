/** requests／reports／admin（維運）路由的 OpenAPI schema（文件與契約測試共用）。 */
import { z } from '@hono/zod-openapi';

/**
 * trip_requests 資料列（`SELECT *` / `RETURNING *`）。chat 後端的請求佇列。
 * 注意：回應經 json() 做 snake_case → camelCase 轉換，所以欄位是 tripId、submittedBy…；
 * 但 PATCH body 的 `processed_by` 仍是 snake（handler 讀的就是這個名字，見 Requests_PatchBody）。
 */
export const Requests_Row = z.object({
  id: z.number().int(),
  tripId: z.string(),
  message: z.string(),
  submittedBy: z.string().nullable().describe('送出者 email'),
  reply: z.string().nullable(),
  status: z.enum(['open', 'processing', 'completed', 'failed']),
  actionsTaken: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  processedBy: z.enum(['api', 'job']).nullable(),
  terminalReason: z.string().nullable().describe('cancelled／timed_out／error／needs_consent；未終結為 null'),
}).openapi('Requests_Row');

/** GET 系列會 LEFT JOIN users，多一欄 submittedByDisplayName（找不到使用者為 null）。 */
export const Requests_RowWithName = Requests_Row.extend({
  submittedByDisplayName: z.string().nullable(),
}).openapi('Requests_RowWithName');

export const Requests_ListQuery = z.object({
  tripId: z.string().optional().describe('不帶時須是帶 ops:trips:read 的 service token'),
  status: z.string().optional(),
  limit: z.coerce.number().int().optional().describe('預設 10，範圍 1–50；帶 limit／before／after 任一個就回分頁形狀'),
  sort: z.enum(['asc', 'desc']).optional(),
  before: z.string().optional(),
  beforeId: z.string().optional(),
  after: z.string().optional(),
  afterId: z.string().optional(),
});

/** 沒帶分頁參數回陣列（向下相容，最多 50 筆）；帶了回 { items, hasMore }。 */
export const Requests_ListResponse = z.union([
  z.array(Requests_RowWithName),
  z.object({ items: z.array(Requests_RowWithName), hasMore: z.boolean() }),
]).openapi('Requests_ListResponse');

export const Requests_CreateBody = z.object({
  tripId: z.string(),
  message: z.string().optional().describe('必填，除非改用舊欄位 title + body（合併成 message）'),
  title: z.string().optional(),
  body: z.string().optional(),
  mode: z.string().optional().describe('已廢棄，handler 忽略'),
}).openapi('Requests_CreateBody');

export const Requests_PatchBody = z.object({
  reply: z.string().optional(),
  status: z.enum(['open', 'processing', 'completed', 'failed']).optional().describe('不可倒退（終結狀態間除外）'),
  processed_by: z.enum(['api', 'job']).optional(),
  terminalReason: z.enum(['cancelled', 'timed_out', 'error', 'needs_consent']).optional(),
}).openapi('Requests_PatchBody');

export const Reports_Body = z.object({
  tripId: z.string(),
  url: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  userAgent: z.string().optional(),
  context: z.string().optional(),
  website: z.string().optional().describe('蜜罐欄位：有值就假裝成功、不儲存'),
  email_confirm: z.string().optional().describe('蜜罐欄位：同 website'),
}).openapi('Reports_Body');

export const Reports_Ok = z.object({ ok: z.boolean() }).openapi('Reports_Ok');

export const Admin_BackfillStatus = z.object({
  version: z.number().int(),
  pending: z.number().int(),
  completed: z.number().int(),
  total: z.number().int(),
  migration_applied_at: z.string().nullable(),
  last_backfill_run_at: z.string().nullable(),
}).openapi('Admin_BackfillStatus');

export const Admin_CacheCleanup = z.object({ deleted: z.number().int() }).openapi('Admin_CacheCleanup');

export const Admin_MapsLockBody = z.object({ reason: z.string().optional().describe('預設 "manual lock by admin"，存入時截 200 字') });
export const Admin_MapsLock = z.object({ locked: z.boolean(), reason: z.string(), locked_at: z.string() }).openapi('Admin_MapsLock');
export const Admin_MapsUnlock = z.object({ locked: z.boolean(), unlocked_at: z.string(), previous_reason: z.string() }).openapi('Admin_MapsUnlock');
export const Admin_MapsSettings = z.object({
  is_locked: z.boolean(),
  locked_reason: z.string(),
  locked_at: z.string().nullable(),
}).openapi('Admin_MapsSettings');

export const Admin_LimitQuery = z.object({
  limit: z.coerce.number().int().optional().describe('預設 50；due-refresh 上限 200、pending-place-id 上限 500'),
});
export const Admin_PoisDueRefresh = z.object({
  rows: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    place_id: z.string(),
    last_refreshed_at: z.string().nullable(),
  })),
}).openapi('Admin_PoisDueRefresh');
export const Admin_PoisPendingPlaceId = z.object({
  rows: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    address: z.string().nullable(),
    place_id: z.null().describe('恆為 null（篩選條件）'),
  })),
}).openapi('Admin_PoisPendingPlaceId');

/** 本月至今各 consumed_api method 的請求數（Google Cloud Monitoring）。 */
export const Admin_QuotaEstimate = z.array(z.object({ method: z.string(), count: z.number() })).openapi('Admin_QuotaEstimate');
