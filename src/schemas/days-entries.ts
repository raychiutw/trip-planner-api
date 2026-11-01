/**
 * days / entries 路由組的 OpenAPI schema（文件用，不在執行期驗證；由 tests/contract/days-entries.contract.test.ts 保證與實際回應一致）。
 *
 * 注意：這組 handler 用 `json()` 回應，**回應的 key 一律被轉成 camelCase**（資料庫的 snake_case 欄位 `day_num` 對外是 `dayNum`）；
 * 但請求 body 是原樣讀取，維持 snake_case（`start_time`、`sort_order`…）與 camelCase（`poiId`、`entryPoisVersion`）混用的現況。
 *
 * 命名前綴 `DaysEntries_`。欄位的「必填／選填／可為 null」依 handler 實際行為區分：
 * - 回應：DB 欄位可為 NULL 的一律 `.nullable()`；
 * - 請求 body：handler 沒有強制的欄位一律 `.optional()`（PATCH 都是部分更新）。
 */
import { z } from '@hono/zod-openapi';

// ───────────── 回應共用形狀 ─────────────

/** GET /days（不帶 all）的每日摘要；POST /days 的 `day` 也是同一形狀。id 在極端情況下可能為 null（POST 取不到 last_row_id）。 */
export const DaySummary = z.object({
  id: z.number().int().nullable(),
  dayNum: z.number().int(),
  date: z.string().nullable().openapi({ example: '2026-04-01', description: 'YYYY-MM-DD；空行程新增第一天時可為 null' }),
  dayOfWeek: z.string().nullable().openapi({ example: '三' }),
  label: z.string().nullable(),
}).openapi('DaysEntries_DaySummary');

/** trip_entries 資料列（`SELECT *` / `RETURNING *` 原樣回傳；entry 層級的 note 已於 migration 0078 移除，改放各 POI 上）。 */
export const EntryRow = z.object({
  id: z.number().int(),
  dayId: z.number().int(),
  sortOrder: z.number().int(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  updatedAt: z.string(),
  orderInDay: z.number().int(),
  startTime: z.string().nullable().openapi({ example: '10:00', description: 'HH:MM' }),
  endTime: z.string().nullable().openapi({ example: '11:30', description: 'HH:MM' }),
  entryPoisVersion: z.number().int().openapi({ description: '結構 OCC 計數器（資料列原值，數字）。注意：GET entry／days 回應裡同名欄位被覆寫成字串，見 EntryDetail。' }),
  version: z.number().int().openapi({ description: 'PATCH /entries/:eid 的 OCC 版本（expectedVersion 對應此值）' }),
}).openapi('DaysEntries_EntryRow');

/** entry 底下某個 POI（正選 sort_order=1 / 備選 sort_order>1）的合併資訊：trip_entry_pois + pois。 */
export const EntryPoi = z.object({
  poiId: z.number().int(),
  sortOrder: z.number().int(),
  name: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  type: z.string().nullable(),
  category: z.string().nullable(),
  source: z.string().nullable(),
  hours: z.string().nullable(),
  rating: z.number().nullable(),
  price: z.string().nullable(),
  reservation: z.string().nullable(),
  reservationUrl: z.string().nullable(),
  description: z.string().nullable(),
  note: z.string().nullable(),
}).openapi('DaysEntries_EntryPoi');

/** 與前一景點之間的車程（來自 trip_segments）。 */
export const Travel = z.object({
  type: z.string().nullable().openapi({ description: "'car' / 'walk' / transit 等；同一地點（sameplace）時為 null" }),
  submode: z.string().nullable(),
  sameplace: z.boolean(),
  desc: z.null(),
  min: z.number().nullable(),
  distanceM: z.number().nullable(),
  source: z.string().nullable(),
}).openapi('DaysEntries_Travel');

const EntryPois = {
  master: EntryPoi.nullable(),
  alternates: z.array(EntryPoi),
  stopPois: z.array(EntryPoi),
  entryPoisVersion: z.string().nullable().openapi({ description: '結構 OCC token（字串；對應 entryPoisVersion 請求欄位）' }),
};

/** GET /entries/:eid：entry 欄位 + 正選／備選／全部停留點；`entryPoisVersion` 為字串（覆寫資料列的數字）。 */
export const EntryDetail = EntryRow.omit({ entryPoisVersion: true }).extend({
  ...EntryPois,
  entryPoisVersion: z.string(),
}).openapi('DaysEntries_EntryDetail');

/** 一天內的 timeline 項目：entry 欄位 + travel + POI 資訊。 */
export const TimelineEntry = EntryRow.omit({ entryPoisVersion: true }).extend({
  travel: Travel.nullable(),
  ...EntryPois,
}).openapi('DaysEntries_TimelineEntry');

/** pois 資料列（`SELECT *`）。飯店與停車場都用這個形狀。 */
export const PoiRow = z.object({
  id: z.number().int(),
  type: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  note: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  hours: z.string().nullable(),
  rating: z.number().nullable(),
  category: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  country: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  osmId: z.number().nullable(),
  osmType: z.string().nullable(),
  wikidataId: z.string().nullable(),
  cuisine: z.string().nullable(),
  dataSource: z.string().nullable(),
  dataFetchedAt: z.number().nullable(),
  placeId: z.string().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  statusCheckedAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  price: z.string().nullable(),
}).openapi('DaysEntries_PoiRow');

export const DayHotel = PoiRow.extend({ parking: z.array(PoiRow) }).openapi('DaysEntries_DayHotel');

/** 完整的一天（GET /days?all=1 與 GET /days/:num）。 */
export const DayFull = z.object({
  id: z.number().int(),
  dayNum: z.number().int(),
  date: z.string().nullable(),
  dayOfWeek: z.string().nullable(),
  label: z.string().nullable(),
  version: z.number().int().openapi({ description: 'Day 層級 OCC token（PUT /days/:num 的 expectedDayVersion）' }),
  hotel: DayHotel.nullable(),
  timeline: z.array(TimelineEntry),
}).openapi('DaysEntries_DayFull');

/** trip_entry_pois 資料列（POST /trip-pois 的回應，`RETURNING *`）。 */
export const EntryPoiRow = z.object({
  id: z.number().int(),
  entryId: z.number().int(),
  poiId: z.number().int(),
  sortOrder: z.number().int(),
  addedAt: z.string(),
  updatedAt: z.string(),
  description: z.string().nullable(),
  note: z.string().nullable(),
  reservation: z.string().nullable(),
  reservationUrl: z.string().nullable(),
}).openapi('DaysEntries_EntryPoiRow');

export const Ok = z.object({ ok: z.literal(true) }).openapi('DaysEntries_Ok');

// ───────────── query ─────────────

export const DaysListQuery = z.object({
  all: z.string().optional().openapi({ description: "傳 '1' 回完整 days（含飯店、timeline、POI）；其他值回摘要" }),
});

export const AlternateDeleteQuery = z.object({
  entryPoisVersion: z.string().optional().openapi({ description: 'OCC token；DELETE 沒有 body，所以走 query。不符 → 409 STALE_ENTRY' }),
});

// ───────────── request body ─────────────

export const DaysCreateBody = z.object({
  position: z.enum(['start', 'end', 'insert']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "position='insert' 時必填（YYYY-MM-DD），且不可與既有日期重複" }),
});

export const DaysShiftBody = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ description: '新的 Day 1 日期；其餘天保留相對間隔一起平移' }),
});

/** PUT /days/:num 的 POI 項目（master / alternates / stopPois / hotel / shopping 共用）；欄位多數選填，也接受 snake_case 別名。 */
const ReplaceDayPoi = z.object({
  name: z.string().optional(),
  poiId: z.number().int().positive().optional().openapi({ description: '直接指定既有 POI（也接受 poi_id）；指定後忽略 name' }),
  poi_id: z.number().int().positive().optional(),
  type: z.string().optional().openapi({ description: 'hotel/restaurant/shopping/parking/attraction/transport/activity/other' }),
  description: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  reservation: z.string().nullable().optional(),
  reservationUrl: z.string().nullable().optional(),
  reservation_url: z.string().nullable().optional(),
  hours: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
});

const ReplaceDayEntry = z.object({
  name: z.string().optional().openapi({ description: '沒有 stopPois／master／alternates 時，用 name 建立一個正選 POI' }),
  poi_type: z.string().optional().openapi({ description: '預設 attraction' }),
  time: z.string().nullable().optional().openapi({ description: "legacy：'HH:MM' 或 'HH:MM-HH:MM'" }),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  note: z.string().nullable().optional().openapi({ description: '正選自己沒備註時繼承此值' }),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  rating: z.number().nullable().optional(),
  master: ReplaceDayPoi.nullable().optional(),
  alternates: z.array(ReplaceDayPoi).optional(),
  stopPois: z.array(ReplaceDayPoi).optional(),
  shopping: z.array(ReplaceDayPoi).optional().openapi({ description: '舊欄位；併入備選' }),
});

export const DayReplaceBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayOfWeek: z.string(),
  label: z.string().min(1).max(8),
  hotel: ReplaceDayPoi.extend({ parking: z.array(ReplaceDayPoi).optional() }).nullable().optional(),
  timeline: z.array(ReplaceDayEntry).optional().openapi({ description: '整天覆寫：沒帶或空陣列＝清空這天的行程' }),
  expectedDayVersion: z.number().int().optional().openapi({ description: '帶了且與目前 version 不符 → 409 STALE_ENTRY；沒帶則略過檢查' }),
});

export const EntryCreateBody = z.object({
  name: z.string().min(1).openapi({ description: '非空白' }),
  poi_type: z.enum(['hotel', 'restaurant', 'shopping', 'parking', 'attraction', 'transport', 'activity', 'other']).optional().openapi({ description: '預設 attraction' }),
  lat: z.number().min(-90).max(90).nullable().optional().openapi({ description: 'lat／lng 必須同時提供' }),
  lng: z.number().min(-180).max(180).nullable().optional(),
  rating: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  note: z.string().nullable().optional().openapi({ description: '成為正選 POI 的備註' }),
  source: z.enum(['ai', 'google', 'favorite', 'custom', 'search', 'user-explore', 'manual']).nullable().optional().openapi({ description: '預設 ai' }),
  time: z.string().nullable().optional().openapi({ description: "legacy：'HH:MM' 或 'HH:MM-HH:MM'" }),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  sort_order: z.number().int().min(0).optional().openapi({ description: '沒給就加在最後' }),
});

const BatchUpdateItem = z.object({
  id: z.number().int().positive().openapi({ description: 'entry id，必須屬於此行程' }),
  sort_order: z.number().int().optional(),
  day_id: z.number().int().positive().optional().openapi({ description: '跨天移動；目標 day 必須屬於同一行程' }),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
});
export const EntriesBatchBody = z.object({
  updates: z.array(BatchUpdateItem).min(1).openapi({ description: '每項至少要帶 sort_order／day_id／start_time／end_time 其中一個；同一批內 (day_id, sort_order) 不可重複' }),
});

/** PATCH /entries/:eid：部分更新，只有 ALLOWED_FIELDS（day_id/sort_order/start_time/end_time/description/source）會寫入，其他欄位被忽略。 */
export const EntryPatchBody = z.object({
  day_id: z.number().int().positive().optional().openapi({ description: '跨天移動；目標 day 必須屬於同一行程' }),
  sort_order: z.number().int().optional(),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  description: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  time: z.string().nullable().optional().openapi({ description: "legacy：'HH:MM' 或 'HH:MM-HH:MM'，會拆成 start_time／end_time；null 清空兩者" }),
  expectedVersion: z.number().int().optional().openapi({ description: 'OCC：對應 entry 的 version；不符 → 409 STALE_ENTRY。沒帶則略過檢查（version 仍會 +1）' }),
});

/** 以 poiId 指定既有 POI，或帶 name／lat／lng 從搜尋結果 find-or-create（兩種擇一）。 */
const PoiRef = z.object({
  poiId: z.number().int().positive().optional(),
  name: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  address: z.string().optional(),
  rating: z.number().optional(),
  country: z.string().optional(),
  source: z.string().optional(),
  entryPoisVersion: z.string().optional().openapi({ description: 'OCC token（取自 GET 的 entry_pois_version）；不符 → 409 STALE_ENTRY' }),
});
export const AlternateAddBody = PoiRef;
export const PoiIdReplaceBody = PoiRef;

export const AlternateReorderBody = z.object({
  order: z.array(z.number().int().positive()).openapi({ description: '備選 POI id 的新順序（不含正選）；必須與目前備選集合完全相同，否則 422 INVALID_ORDER' }),
  entryPoisVersion: z.string().optional(),
});

export const EntryCopyBody = z.object({
  targetDayId: z.number().int().positive().openapi({ description: '必須屬於同一行程' }),
  sortOrder: z.number().int().optional().openapi({ description: '預設加在目標天最後' }),
  time: z.string().nullable().optional().openapi({ description: '覆寫來源的時間（legacy 格式）；沒帶就沿用來源的 start_time／end_time' }),
});

export const EntryMasterBody = z.object({
  poiId: z.number().int().positive(),
  entryPoisVersion: z.string().optional(),
  version: z.string().optional().openapi({ description: 'entryPoisVersion 的舊別名；兩者都帶時以 entryPoisVersion 為準' }),
});

export const EntryTripPoiBody = z.object({
  name: z.string().min(1),
  type: z.enum(['restaurant', 'shopping', 'attraction', 'activity', 'transport', 'other']),
  description: z.string().optional(),
  note: z.string().optional(),
  hours: z.string().optional(),
  rating: z.number().optional(),
  category: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  price: z.string().optional(),
  reservation: z.string().optional(),
  reservation_url: z.string().optional(),
});

/** PATCH /entries/:eid/pois/:poiId：note／poi_type／reservation 至少要帶一個。 */
export const EntryPoiPatchBody = z.object({
  note: z.string().max(1000).nullable().optional().openapi({ description: 'trim 後空字串＝清除（存成 null）' }),
  poi_type: z.enum(['hotel', 'restaurant', 'shopping', 'parking', 'attraction', 'transport', 'activity', 'other']).optional().openapi({ description: '改分類＝把這一列改指向「同名＋新分類」的 POI，回應的 poiId 可能因此改變' }),
  reservation: z.string().max(500).nullable().optional(),
});

// ───────────── 其他回應 ─────────────

export const DayCreateResponse = z.object({ day: DaySummary }).openapi('DaysEntries_DayCreateResponse');
export const DayShiftResponse = z.object({
  ok: z.literal(true),
  newStartDate: z.string(),
  newEndDate: z.string().nullable(),
  daysShifted: z.number().int(),
}).openapi('DaysEntries_DayShiftResponse');
export const DayReplaceResponse = z.object({ ok: z.literal(true), dayVersion: z.number().int() }).openapi('DaysEntries_DayReplaceResponse');
export const DayDeleteResponse = z.object({ ok: z.literal(true), removedEntryCount: z.number().int() }).openapi('DaysEntries_DayDeleteResponse');
export const EntriesBatchResponse = z.object({ ok: z.literal(true), updated: z.number().int() }).openapi('DaysEntries_EntriesBatchResponse');
export const AlternateAddResponse = z.object({
  entryId: z.number().int(),
  poiId: z.number().int(),
  sortOrder: z.number().int(),
  entryPoisVersion: z.string(),
}).openapi('DaysEntries_AlternateAddResponse');
export const AlternateReorderResponse = z.object({
  entryId: z.number().int(),
  order: z.array(z.number().int()),
  entryPoisVersion: z.string(),
}).openapi('DaysEntries_AlternateReorderResponse');
export const AlternateRemoveResponse = z.object({
  entryId: z.number().int(),
  poiId: z.number().int(),
  entryPoisVersion: z.string(),
}).openapi('DaysEntries_AlternateRemoveResponse');
export const EntryMasterResponse = z.object({
  entryId: z.number().int(),
  masterPoiId: z.number().int(),
  oldMasterPoiId: z.number().int().nullable(),
  entryPoisVersion: z.string(),
}).openapi('DaysEntries_EntryMasterResponse');
export const PoiIdReplaceResponse = z.object({ ok: z.literal(true), poiId: z.number().int() }).openapi('DaysEntries_PoiIdReplaceResponse');
export const EntryPoiPatchResponse = z.object({
  entryId: z.number().int(),
  poiId: z.number().int(),
  type: z.string(),
  note: z.string().nullable(),
  reservation: z.string().nullable(),
}).openapi('DaysEntries_EntryPoiPatchResponse');

/** GET /days：不帶 all 回摘要陣列，all=1 回完整陣列（兩種形狀擇一）。 */
export const DaysListResponse = z.union([z.array(DaySummary), z.array(DayFull)]);
