/**
 * trips-core 路由組（行程本體、封存、稽核、健檢、交通段）的請求／回應 schema。
 * 只做文件，不在執行期驗證（驗證仍由 handler 負責）；契約測試用同一份 schema 驗證實際回應。
 *
 * 命名慣例：
 * - 回應經 `json()` 做 snake_case → camelCase 深層轉換，所以回應欄位一律 camelCase；
 *   例外：`GET /trips/:id/health` 用裸 Response，回應維持 snake_case（見 Trips_TripHealth）。
 * - 請求 body 不轉換，handler 直接讀 body 的原始鍵名，所以 `data_source`、`day_quota`、`sub_areas`
 *   在請求中是 snake_case（與回應不一致，照實記錄）。
 */
import { z } from '@hono/zod-openapi';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ───────────── 共用小物件 ───────────── */

/** 各端點通用的 `{ ok: true }`。 */
export const Trips_Ok = z.object({ ok: z.literal(true) }).openapi('Trips_Ok');

/** 行程目的地（建立／更新 body）。欄位是 snake_case，因為 handler 直接讀 body 原始鍵名。 */
export const Trips_DestinationInput = z.object({
  name: z.string().min(1),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  day_quota: z.number().nullable().optional(),
  sub_areas: z.array(z.string()).nullable().optional(),
}).openapi('Trips_DestinationInput');

/* ───────────── 列表 ───────────── */

/** GET /api/my-trips 的一筆：使用者有 trip_permissions 的行程摘要。 */
export const Trips_MyTripSummary = z.object({
  tripId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  /** 擁有者 email（LEFT JOIN users，擁有者帳號不存在時為 null）。 */
  owner: z.string().nullable(),
  ownerDisplayName: z.string().nullable(),
  ownerUserId: z.string(),
  /** 呼叫者在此行程的角色。 */
  role: z.enum(['owner', 'member', 'viewer']),
  countries: z.string().nullable(),
  updatedAt: z.string(),
  /** 封存時間；未封存為 null。 */
  archivedAt: z.string().nullable(),
  totalDays: z.number().int(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  memberCount: z.number().int(),
}).openapi('Trips_MyTripSummary');
export const Trips_MyTripList = z.array(Trips_MyTripSummary);

/** GET /api/trips 的一筆：公開行程清單，刻意不含擁有者 email／名稱（個資）。 */
export const Trips_TripListItem = z.object({
  tripId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  title: z.string().nullable(),
  countries: z.string().nullable(),
  /** 1 = 已發布。 */
  published: z.number().int(),
  dataSource: z.string().nullable(),
  lang: z.string().nullable(),
  dayCount: z.number().int(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  memberCount: z.number().int(),
}).openapi('Trips_TripListItem');
export const Trips_TripList = z.array(Trips_TripListItem);

export const Trips_ListQuery = z.object({
  all: z.string().optional().openapi({
    description: '傳 `1` 且為帶 `ops:trips:read` scope 的 service token 時，回傳全部行程（含未發布）；其他情況一律只回已發布行程。',
    example: '1',
  }),
});

/* ───────────── 建立／匯入 ───────────── */

/**
 * POST /api/trips 的 body。**不可帶 `id`**（行程 ID 由伺服器產生，帶了回 400）。
 * handler 的驗證：name／startDate／endDate 必填；日期 YYYY-MM-DD 且 end ≥ start、最多 30 天；
 * lang、data_source 為列舉；destinations 最多 30 筆（沒有 name 字串的元素會被略過）。
 */
export const Trips_CreateBody = z.object({
  name: z.string().min(1),
  startDate: z.string().regex(DATE_RE),
  endDate: z.string().regex(DATE_RE),
  title: z.string().optional(),
  description: z.string().optional(),
  countries: z.string().optional().openapi({ description: '預設 `JP`。' }),
  /** handler 以 `Number(value)` 轉換，所以布林與數字都接受；預設 0（未發布）。 */
  published: z.union([z.number(), z.boolean()]).optional(),
  data_source: z.enum(['manual', 'tp-create', 'imported']).optional(),
  lang: z.enum(['zh-TW', 'en', 'ja']).optional(),
  destinations: z.array(Trips_DestinationInput).max(30).optional(),
}).openapi('Trips_CreateBody');

export const Trips_CreateResult = z.object({
  ok: z.literal(true),
  tripId: z.string(),
  daysCreated: z.number().int(),
  destinationsCreated: z.number().int(),
}).openapi('Trips_CreateResult');

/**
 * POST /api/trips/import 的 body：`GET /api/trips/:id` 系列匯出的 v1 檔案（`schemaVersion: 1`）。
 * 整份內容是攻擊者可控的 JSON，由 `parseAndValidateImport` 逐欄白名單讀取、降級與截斷，
 * 因此文件只宣告頂層結構：`days`／`segments`／`notes`／`meta.destinations` 內部是結構鬆散、
 * 會被 handler 容錯正規化的動態資料，用 record 表達，不假裝有固定結構。
 * 限制：原文最大 512KB（以實際字數計，超過回 400）；天數 ≤ 366、每日景點 ≤ 100、景點總數 ≤ 1000、
 * POI 總數 ≤ 400、交通段 ≤ 3000、每類備註 ≤ 100；含 `weather`／`weather_json` 或
 * `__proto__`／`constructor`／`prototype` 鍵一律 400；每位使用者有行程數上限。
 */
export const Trips_ImportBody = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    countries: z.string().optional(),
    lang: z.enum(['zh-TW', 'en', 'ja']).optional(),
    destinations: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
  }).catchall(z.unknown()).openapi({ description: '`name` 與 `title` 至少要有一個非空字串，否則回 400「行程缺少名稱」。' }),
  days: z.array(z.record(z.string(), z.unknown())).max(366).optional(),
  segments: z.array(z.record(z.string(), z.unknown())).max(3000).optional(),
  notes: z.record(z.string(), z.unknown()).optional(),
}).catchall(z.unknown()).openapi('Trips_ImportBody');

export const Trips_ImportResult = z.object({
  ok: z.literal(true),
  tripId: z.string(),
  daysCreated: z.number().int(),
}).openapi('Trips_ImportResult');

/* ───────────── 單一行程 ───────────── */

export const Trips_TripDestination = z.object({
  destOrder: z.number().int(),
  name: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  dayQuota: z.number().int().nullable(),
  /** 存成 JSON 字串；handler 解析後回傳（正常為字串陣列，解析失敗時回原字串，無則 null），型別因此不固定。 */
  subAreas: z.unknown(),
}).openapi('Trips_TripDestination');

/** GET /api/trips/:id：`SELECT * FROM trips` 加上別名 `tripId`（等於 `id`）與 `destinations`。 */
export const Trips_Trip = z.object({
  id: z.string(),
  tripId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  countries: z.string().nullable(),
  /** 1 = 已發布（可匿名讀取）。 */
  published: z.number().int(),
  dataSource: z.string().nullable(),
  lang: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  destinations: z.array(Trips_TripDestination),
}).openapi('Trips_Trip');

/**
 * PUT /api/trips/:id 的 body：只更新有帶的白名單欄位；至少要有一個白名單欄位或 `destinations`，
 * 否則 400。欄位值 handler 不做型別驗證（直接綁進 SQL），lang／data_source 有列舉檢查。
 * `destinations` 是整批取代（帶空陣列＝清空；沒帶＝不動），最多 30 筆。
 */
export const Trips_UpdateBody = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  countries: z.string().optional(),
  published: z.union([z.number(), z.boolean()]).optional(),
  data_source: z.enum(['manual', 'tp-create', 'imported']).optional(),
  lang: z.enum(['zh-TW', 'en', 'ja']).optional(),
  destinations: z.array(Trips_DestinationInput).max(30).optional(),
}).openapi('Trips_UpdateBody');

export const Trips_ArchiveResult = z.object({
  archivedAt: z.string().nullable().openapi({ description: '封存時間；取消封存後為 null。' }),
}).openapi('Trips_ArchiveResult');

/* ───────────── 稽核與還原 ───────────── */

export const Trips_AuditQuery = z.object({
  limit: z.coerce.number().optional().openapi({ description: '預設 20，範圍 1–100（超出會被夾住）。' }),
  request_id: z.string().optional().openapi({ description: '只看某個 request 產生的紀錄；必須是正整數，否則 400。' }),
});

/** audit_log 的一列（`SELECT *` 轉 camelCase）。`diffJson`／`snapshot` 是 JSON 字串，內容依 `tableName` 而異。 */
export const Trips_AuditEntry = z.object({
  id: z.number().int(),
  tripId: z.string(),
  tableName: z.string(),
  recordId: z.number().int().nullable(),
  action: z.enum(['insert', 'update', 'delete']),
  changedBy: z.string().nullable(),
  changedByUserId: z.string().nullable(),
  requestId: z.number().int().nullable(),
  diffJson: z.string().nullable(),
  snapshot: z.string().nullable(),
  createdAt: z.string(),
  companionFailureReason: z.string().nullable(),
}).openapi('Trips_AuditEntry');
export const Trips_AuditList = z.array(Trips_AuditEntry);

export const Trips_RollbackResult = z.object({
  ok: z.literal(true),
  /** handler 內部鍵名是 `rolled_back`，經 `json()` 轉換後實際回應為 camelCase `rolledBack`。 */
  rolledBack: z.enum(['delete->re-insert', 'update->revert', 'insert->delete']),
}).openapi('Trips_RollbackResult');

/* ───────────── 健檢 ───────────── */

/**
 * 健檢報告。`findings` 是 LLM 產出的結構（severity／dimension／title／description／suggestion／
 * actionTarget 等），格式由 prompt 約定、不保證固定，且鍵名會被轉成 camelCase，故用 record 表達。
 */
export const Trips_HealthReport = z.object({
  tripId: z.string(),
  userId: z.string().nullable(),
  /** `pending`／`completed`／`failed`（由 PATCH /api/requests/:id 的完成 hook 寫入）。 */
  status: z.string(),
  requestId: z.number().int().nullable(),
  findings: z.array(z.record(z.string(), z.unknown())),
  /** POST 回應不帶此欄位（只有 GET 有）。 */
  errorMessage: z.string().nullable().optional(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
}).openapi('Trips_HealthReport');

/** GET：尚未做過健檢時 `report` 為 null。 */
export const Trips_HealthCheckResult = z.object({
  report: Trips_HealthReport.nullable(),
}).openapi('Trips_HealthCheckResult');

/** POST：一定有 report（新建 202，30 秒內重複觸發回既有 pending 的 200）。 */
export const Trips_HealthCheckTriggerResult = z.object({
  report: Trips_HealthReport,
}).openapi('Trips_HealthCheckTriggerResult');

/**
 * GET /api/trips/:id/health：這條 handler 用裸 `Response`、不經 `json()`，
 * 所以 `items` 內的鍵名維持 snake_case（與同組其他端點不一致）。
 */
export const Trips_TripHealth = z.object({
  version: z.literal(1),
  closed: z.number().int(),
  missing: z.number().int(),
  items: z.array(z.object({
    poi_id: z.number().int(),
    poi_name: z.string(),
    status: z.enum(['closed', 'missing']),
    reason: z.string().nullable(),
  })),
}).openapi('Trips_TripHealth');

/* ───────────── 交通段 ───────────── */

export const Trips_Segment = z.object({
  id: z.number().int(),
  tripId: z.string(),
  fromEntryId: z.number().int(),
  toEntryId: z.number().int(),
  mode: z.enum(['driving', 'walking', 'transit']),
  /** 只有 transit 有意義（monorail／bus／metro／train／hsr／自由文字，最多 20 字）。 */
  submode: z.string().nullable(),
  /** 分鐘；尚未算出或標為免交通時為 null。 */
  min: z.number().int().nullable(),
  distanceM: z.number().int().nullable(),
  /** `google`／`manual`／`haversine`；未算出或免交通為 null。`manual` 代表使用者鎖定，recompute 不覆寫。 */
  source: z.string().nullable(),
  /** epoch 毫秒；null＝待重算（stale）。 */
  computedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  version: z.number().int(),
  /** 1＝同一地點／免交通；其餘為 null。 */
  noTravel: z.number().int().nullable(),
}).openapi('Trips_Segment');
export const Trips_SegmentList = z.array(Trips_Segment);

const SegmentMode = z.enum(['driving', 'walking', 'transit']);

/**
 * POST /api/trips/:id/segments 的 body（同一對 from／to 重送＝upsert）。
 * `noTravel: true` 時略過 mode／min。否則 mode 必填；`min` 有帶就必須是 1–1440；
 * 純手填的大眾運輸方式缺 `min` 會回 400。driving／walking 會忽略手填的 `min`，重新向 Google 計算。
 * 欄位名 `from_entry_id`／`to_entry_id` 為 snake_case，`noTravel` 為 camelCase（同一 body 內混用，照實記錄）。
 */
export const Trips_SegmentCreateBody = z.object({
  from_entry_id: z.number().int().positive(),
  to_entry_id: z.number().int().positive(),
  mode: SegmentMode.optional(),
  min: z.number().min(1).max(1440).optional(),
  submode: z.string().nullable().optional(),
  noTravel: z.boolean().optional(),
}).openapi('Trips_SegmentCreateBody');

/** PATCH /api/trips/:id/segments/:sid 的 body；`expectedVersion` 與目前版本不符回 409。 */
export const Trips_SegmentPatchBody = z.object({
  mode: SegmentMode.optional(),
  min: z.number().min(1).max(1440).optional(),
  /** 省略＝保留現值（不是清除）。 */
  submode: z.string().nullable().optional(),
  noTravel: z.boolean().optional(),
  expectedVersion: z.number().int().optional(),
}).openapi('Trips_SegmentPatchBody');

export const Trips_RecomputeQuery = z.object({
  day: z.string().optional().openapi({ description: '正整數（只重算該天）或 `all`；預設重算整個行程。其他值回 400。' }),
});

export const Trips_RecomputeResult = z.object({
  ok: z.literal(true),
  tripId: z.string(),
  daysProcessed: z.number().int(),
  pairsComputed: z.number().int(),
  pairsSkippedTransit: z.number().int(),
  pairsSkippedMissingCoords: z.number().int(),
  segmentsPruned: z.number().int(),
  /** 鍵為 `google`／`haversine`／`error` 等來源名稱，值為筆數；鍵集合隨實際發生的來源而變，故用 record。 */
  sourceBreakdown: z.record(z.string(), z.number()),
  /** 鍵為 `driving`／`walking`／`transit`，值為筆數；只含實際出現的方式。 */
  modeBreakdown: z.record(z.string(), z.number()),
  errorsDetail: z.array(z.object({ entryId: z.number().int(), message: z.string() })),
}).openapi('Trips_RecomputeResult');
