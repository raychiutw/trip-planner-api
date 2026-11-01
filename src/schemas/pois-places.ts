/**
 * pois-places 組（places、poi-favorites、poi-search、pois、route、public-config）的 OpenAPI schema。
 * 全部從 handler 實際回傳的內容推導；契約測試（tests/contract/pois-places.contract.test.ts）以同一份 schema 驗證實際回應。
 *
 * 注意：這些端點的 429 有三種不同形狀（歷史原因，文件照實描述、不改 handler）：
 * - places/autocomplete、places/resolve：`{ error: { code, detail } }`，**沒有 message**（Pois_RateLimitedNoMessage）。
 * - poi-favorites 寫入類（POST／DELETE／add-to-trip）：`{ error: 'RATE_LIMITED' }`，error 是**字串**（Pois_RateLimitedFlat）。
 * - route、poi-search：標準的 ApiError（含 code + message）。
 * 429 都帶 `Retry-After` 標頭（秒）。
 *
 * 回應的 key 命名不一致（歷史原因）：用 json() 輸出的端點會把 snake_case 轉成 camelCase
 * （poi-favorites 全部、pois 的 PATCH／DELETE／enrich、add-to-trip、resolve），
 * 而 poi-search、route、public-config 用原始 JSON（poi-search 的結果欄位是 snake_case，如 place_id）。
 * 請求 body 則照原樣讀取：PATCH /api/pois/:id 的欄位是 snake_case（place_id、status_reason…），回應卻是 camelCase。
 *
 * Google 相關端點（places、poi-search、route、enrich）的資料來自 Google Maps Platform；
 * 測試中一律用 stub，不連線。
 */
import { z } from '@hono/zod-openapi';

// ---------- 共用錯誤 ----------

/** autocomplete／resolve 的 429：只有 code 與 detail，沒有 message。 */
export const Pois_RateLimitedNoMessage = z.object({
  error: z.object({ code: z.literal('RATE_LIMITED'), detail: z.string() }),
}).openapi('Pois_RateLimitedNoMessage');

/** poi-favorites 寫入類端點的 429：error 是字串。 */
export const Pois_RateLimitedFlat = z.object({
  error: z.literal('RATE_LIMITED'),
}).openapi('Pois_RateLimitedFlat');

// ---------- places ----------

export const Pois_AutocompleteBody = z.object({
  q: z.string().min(2).max(200).openapi({ description: '搜尋字串（trim 後 2–200 字元）', example: '高雄市左營' }),
  sessionToken: z.string().min(1).max(128).openapi({ description: 'Google 計費 session token：前端每次 typeahead 產生一個 UUID' }),
  regionCode: z.string().max(8).optional().openapi({ example: 'tw' }),
}).openapi('Pois_AutocompleteBody');

export const Pois_AutocompleteResponse = z.object({
  predictions: z.array(z.object({
    placeId: z.string(),
    primaryText: z.string(),
    secondaryText: z.string(),
  })),
}).openapi('Pois_AutocompleteResponse');

export const Pois_ResolveQuery = z.object({
  placeId: z.string().min(1).max(256),
  sessionToken: z.string().max(128).optional().openapi({ description: '帶上 autocomplete 的 sessionToken，兩次呼叫合計為一個計費 session' }),
});

export const Pois_ResolveResponse = z.object({
  placeId: z.string(),
  lat: z.number(),
  lng: z.number(),
  name: z.string(),
  address: z.string(),
  hours: z.string().nullable().openapi({ description: '營業時間，每天一行（\\n 分隔）；無則 null' }),
  priceLevel: z.string().nullable().openapi({ description: 'Google 價位 enum；無則 null' }),
}).openapi('Pois_ResolveResponse');

// ---------- poi-favorites ----------

export const Pois_FavoriteUsage = z.object({
  tripId: z.string(),
  tripName: z.string().nullable(),
  dayNum: z.number().int(),
  dayDate: z.string().nullable(),
  entryId: z.number().int().nullable().openapi({ description: '飯店用途（trip_days.hotel_poi_id）沒有 entry，為 null' }),
}).openapi('Pois_FavoriteUsage');

export const Pois_FavoriteListItem = z.object({
  id: z.number().int(),
  userId: z.string(),
  poiId: z.number().int(),
  favoritedAt: z.string(),
  note: z.string().nullable(),
  poiName: z.string(),
  poiAddress: z.string().nullable(),
  poiLat: z.number().nullable(),
  poiLng: z.number().nullable(),
  poiType: z.string(),
  poiRating: z.number().nullable(),
  usages: z.array(Pois_FavoriteUsage).openapi({ description: '這個 POI 在使用者可存取的行程中的使用處' }),
}).openapi('Pois_FavoriteListItem');

export const Pois_FavoriteListResponse = z.array(Pois_FavoriteListItem);

export const Pois_FavoriteCreateBody = z.object({
  poiId: z.number().int().positive(),
  note: z.string().optional(),
}).openapi('Pois_FavoriteCreateBody');

/** poi_favorites 資料列（INSERT／reactivate ... RETURNING *）。 */
export const Pois_FavoriteRow = z.object({
  id: z.number().int(),
  userId: z.string(),
  poiId: z.number().int(),
  favoritedAt: z.string(),
  note: z.string().nullable(),
  deletedAt: z.string().nullable(),
}).openapi('Pois_FavoriteRow');

export const Pois_AddToTripBody = z.object({
  tripId: z.string(),
  dayNum: z.number().int().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: '10:00' }),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: '11:30' }),
}).openapi('Pois_AddToTripBody');

export const Pois_AddToTripResponse = z.object({
  ok: z.literal(true),
  entryId: z.number().int(),
  dayId: z.number().int(),
  sortOrder: z.number().int(),
  startTime: z.string(),
  endTime: z.string(),
  note: z.string().openapi({ description: '固定的說明文字（車程由背景計算），不是使用者的備註' }),
}).openapi('Pois_AddToTripResponse');

/** 時間與既有 entry 重疊：注意 error 是字串 'CONFLICT'（不是巢狀 ApiError）。 */
export const Pois_AddToTripConflict = z.object({
  error: z.literal('CONFLICT'),
  conflictWith: z.object({
    entryId: z.number().int(),
    time: z.string().nullable(),
    title: z.string(),
    dayNum: z.number().int(),
  }),
}).openapi('Pois_AddToTripConflict');

// ---------- poi-search ----------

export const Pois_SearchQuery = z.object({
  q: z.string().min(2).max(200),
  region: z.string().optional().openapi({ description: 'ISO 國碼（如 JP）或城市中文（如 東京）；城市會轉成 locationBias' }),
  limit: z.coerce.number().int().min(1).max(20).optional().openapi({ description: '預設 10，超出範圍會被夾到 1–20' }),
  pageToken: z.string().optional().openapi({ description: '上一頁回傳的 nextPageToken；帶了就不走快取' }),
});

export const Pois_SearchResult = z.object({
  place_id: z.string(),
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  category: z.string().openapi({ description: 'Google primaryType，例如 restaurant' }),
  country: z.string().optional(),
  country_name: z.string().optional(),
  rating: z.number().optional(),
  business_status: z.string().optional(),
}).openapi('Pois_SearchResult');

export const Pois_SearchResponse = z.object({
  results: z.array(Pois_SearchResult),
  nextPageToken: z.string().nullable().openapi({ description: '命中快取時恆為 null（快取只存第一頁）' }),
}).openapi('Pois_SearchResponse');

// ---------- pois ----------

/**
 * pois 資料列（PATCH 回傳 `SELECT *`）。欄位對應 migrations 後的 pois 表。
 * type 有 CHECK 約束（hotel／restaurant／shopping／parking／attraction／transport／activity／other 等），
 * 但約束會隨 migration 演進，文件只標為字串。
 */
export const Pois_PoiRow = z.object({
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
  osmId: z.number().int().nullable(),
  osmType: z.string().nullable(),
  wikidataId: z.string().nullable(),
  cuisine: z.string().nullable(),
  dataSource: z.string().nullable(),
  dataFetchedAt: z.number().int().nullable(),
  placeId: z.string().nullable(),
  status: z.string().openapi({ description: 'active／closed／missing' }),
  statusReason: z.string().nullable(),
  statusCheckedAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  price: z.string().nullable(),
}).openapi('Pois_PoiRow');

/**
 * PATCH 的 body：白名單欄位，其餘欄位被靜默忽略；一個白名單欄位都沒有 → 400。
 * 一般使用者須帶 tripId（且 POI 必須屬於該行程）；ops:poi 維運 token 可省略。
 * 型別依資料庫欄位，handler 不做型別驗證。
 */
export const Pois_PatchBody = z.object({
  tripId: z.string().optional().openapi({ description: '一般使用者必填；不是 POI 欄位，不會被寫入' }),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  hours: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  price: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  country: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  place_id: z.string().nullable().optional(),
  status: z.string().optional(),
  status_reason: z.string().nullable().optional(),
  status_checked_at: z.string().nullable().optional(),
  last_refreshed_at: z.string().nullable().optional(),
  data_source: z.string().nullable().optional(),
  osm_id: z.number().int().nullable().optional(),
  osm_type: z.string().nullable().optional(),
  wikidata_id: z.string().nullable().optional(),
  cuisine: z.string().nullable().optional(),
}).openapi('Pois_PatchBody');

export const Pois_DeleteResponse = z.object({
  ok: z.literal(true),
  deletedTripEntryPois: z.number().int(),
}).openapi('Pois_DeleteResponse');

export const Pois_EnrichQuery = z.object({
  tripId: z.string().optional().openapi({ description: '一般使用者必填；ops:poi 維運 token 可省略' }),
});

export const Pois_EnrichResponse = z.object({
  poiId: z.number().int(),
  name: z.string(),
  placeId: z.string(),
  status: z.enum(['active', 'closed', 'missing']),
  statusReason: z.string().nullable(),
  rating: z.number().nullable(),
  refreshedAt: z.string(),
}).openapi('Pois_EnrichResponse');

export const Pois_FindOrCreateBody = z.object({
  name: z.string().trim().min(1).openapi({ description: 'trim 後不可為空' }),
  type: z.string().min(1),
  description: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  address: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  source: z.string().nullable().optional().openapi({ description: '預設 user-explore' }),
  country: z.string().nullable().optional(),
  place_id: z.string().nullable().optional(),
}).openapi('Pois_FindOrCreateBody');

export const Pois_FindOrCreateResponse = z.object({
  id: z.number().int().openapi({ description: 'POI 主鍵。新建與命中既有資料都回 200（不是 201）' }),
}).openapi('Pois_FindOrCreateResponse');

// ---------- route / public-config ----------

export const Pois_RouteQuery = z.object({
  from: z.string().openapi({ description: 'lng,lat', example: '139.7454,35.6586' }),
  to: z.string().openapi({ description: 'lng,lat', example: '139.7671,35.6812' }),
});

export const Pois_RouteResponse = z.object({
  polyline: z.array(z.tuple([z.number(), z.number()])).openapi({ description: '已解碼的 [lat, lng] 座標序列' }),
  duration: z.number().openapi({ description: '秒' }),
  distance: z.number().openapi({ description: '公尺' }),
}).openapi('Pois_RouteResponse');

export const Pois_PublicConfigResponse = z.object({
  providers: z.object({ google: z.boolean() }),
  features: z.object({
    passwordSignup: z.boolean(),
    emailVerification: z.boolean(),
  }),
}).openapi('Pois_PublicConfigResponse');
