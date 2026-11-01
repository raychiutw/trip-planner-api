import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as S from '../../schemas/pois-places';
import { onRequestPost as placesAutocompletePost } from '../handlers/places/autocomplete';
import { onRequestGet as placesResolveGet } from '../handlers/places/resolve';
import { onRequestGet as poiFavoritesGet, onRequestPost as poiFavoritesPost } from '../handlers/poi-favorites';
import { onRequestDelete as poiFavoritesDelete } from '../handlers/poi-favorites/@id';
import { onRequestPost as poiFavoritesAddToTrip } from '../handlers/poi-favorites/@id/add-to-trip';
import { onRequestGet as poiSearchGet } from '../handlers/poi-search';
import { onRequestPatch as poisPatch, onRequestDelete as poisDelete } from '../handlers/pois/@id';
import { onRequestPost as poisEnrichPost } from '../handlers/pois/@id/enrich';
import { onRequestPost as poisFindOrCreatePost } from '../handlers/pois/find-or-create';
import { onRequestGet as routeGet } from '../handlers/route';
import { onRequestGet as publicConfigGet } from '../handlers/public-config';

/**
 * 這一組的路由登記。
 * 公開端點（對照舊 _middleware.ts）：GET /api/public-config、GET /api/route、GET /api/poi-search 完全公開（'none'）；
 * 其餘一律 'required'。
 *
 * 文件備註：poi-favorites 的四條路由另有 companion（tp-request）專用的分支（header `X-Request-Scope: companion` +
 * `companionRequestId`，以 companion token 代表提交者操作；多出 401 gate 失敗、409 COMPANION_QUOTA_EXCEEDED），
 * 屬內部行為，不寫進一般 client 的文件。companion 的路徑白名單屬舊 middleware，由 requests-ops 組實作。
 */
const err = (description: string) => ({ description, schema: ApiError });
const E401 = err('未登入或 token 無效（AUTH_REQUIRED）');
const E429Flat = { description: '寫入過於頻繁（per-IP 或 per-user 限流）；帶 Retry-After 標頭，body 的 error 是字串', schema: S.Pois_RateLimitedFlat };
const E502 = err('Google 上游失敗或金鑰未設定（MAPS_UPSTREAM_FAILED）');
const E503 = err('Google Maps 已被 kill switch 鎖定（MAPS_LOCKED）');

export function registerPoisPlacesRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, {
    method: 'post', path: '/api/places/autocomplete', auth: 'required', handler: placesAutocompletePost, summary: 'Places 自動完成',
    docs: {
      body: S.Pois_AutocompleteBody,
      responses: {
        200: { description: '預測清單', schema: S.Pois_AutocompleteResponse },
        400: err('q／sessionToken／regionCode 不合規則（DATA_VALIDATION）'),
        401: E401,
        429: { description: '每日 1000 次上限；帶 Retry-After；body 沒有 message', schema: S.Pois_RateLimitedNoMessage },
        502: E502,
        503: E503,
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/places/resolve', auth: 'required', handler: placesResolveGet, summary: 'Places 解析',
    docs: {
      query: S.Pois_ResolveQuery,
      responses: {
        200: { description: '景點詳情', schema: S.Pois_ResolveResponse },
        400: err('placeId 缺少或過長（DATA_VALIDATION）'),
        401: E401,
        404: err('Google 找不到此景點（DATA_NOT_FOUND）'),
        429: { description: '每日 500 次上限；帶 Retry-After；body 沒有 message', schema: S.Pois_RateLimitedNoMessage },
        502: E502,
        503: E503,
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/poi-favorites', auth: 'required', handler: poiFavoritesGet, summary: '收藏列表',
    docs: {
      responses: {
        200: { description: '目前使用者的收藏（新到舊）；匿名或沒有使用者身分的 service token 不會到這裡（401）', schema: S.Pois_FavoriteListResponse },
        401: E401,
        403: err('受限（restrict_trip）token 不可讀取跨行程的收藏（PERM_DENIED）'),
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/poi-favorites', auth: 'required', handler: poiFavoritesPost, summary: '新增收藏',
    docs: {
      body: S.Pois_FavoriteCreateBody,
      responses: {
        201: { description: '收藏資料列（含重新啟用先前取消的收藏）', schema: S.Pois_FavoriteRow },
        400: err('poiId 缺少或無效（DATA_VALIDATION）'),
        401: E401,
        403: err('受限 token 不可寫入收藏（PERM_DENIED）'),
        404: err('POI 不存在（DATA_NOT_FOUND）'),
        409: err('該 POI 已收藏（DATA_CONFLICT）'),
        429: E429Flat,
      },
    },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/poi-favorites/:id', auth: 'required', handler: poiFavoritesDelete, summary: '刪除收藏',
    docs: {
      responses: {
        204: { description: '已取消收藏（soft delete；已取消的再刪一次也回 204）' },
        400: err('id 須為正整數（DATA_VALIDATION）'),
        401: E401,
        403: err('不是自己的收藏，或受限 token（PERM_DENIED）'),
        404: err('找不到該收藏（DATA_NOT_FOUND）'),
        429: E429Flat,
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/poi-favorites/:id/add-to-trip', auth: 'required', handler: poiFavoritesAddToTrip, summary: '收藏加入行程',
    docs: {
      body: S.Pois_AddToTripBody,
      responses: {
        201: { description: '已建立 entry', schema: S.Pois_AddToTripResponse },
        400: err('欄位缺少或格式錯誤，或收藏備註含疑似亂碼（DATA_VALIDATION／DATA_ENCODING）；position／anchorEntryId 已廢除'),
        401: E401,
        403: err('不是自己的收藏、對該行程沒有寫入權限，或受限 token（PERM_DENIED）'),
        404: err('收藏或該天不存在（DATA_NOT_FOUND）'),
        409: { description: '時間與既有 entry 重疊；注意 error 是字串 CONFLICT', schema: S.Pois_AddToTripConflict },
        429: E429Flat,
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/poi-search', auth: 'none', handler: poiSearchGet, summary: 'POI 搜尋（公開）',
    docs: {
      query: S.Pois_SearchQuery,
      responses: {
        200: { description: '搜尋結果；回應標頭 X-Cache 為 HIT／MISS', schema: S.Pois_SearchResponse },
        400: err('q 太短或太長（DATA_VALIDATION）'),
        429: err('per-IP 搜尋過於頻繁（RATE_LIMITED）；帶 Retry-After'),
        502: E502,
        503: E503,
      },
    },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/pois/:id', auth: 'required', handler: poisPatch, summary: '更新 POI',
    docs: {
      body: S.Pois_PatchBody,
      responses: {
        200: { description: '更新後的 POI（欄位為 camelCase）', schema: S.Pois_PoiRow },
        400: err('id 格式錯誤、非維運 token 缺 tripId，或沒有任何有效欄位（DATA_VALIDATION）'),
        401: E401,
        403: err('沒有該行程的寫入權限，或 POI 不屬於該行程（PERM_DENIED）'),
        404: err('找不到此 POI（DATA_NOT_FOUND）'),
      },
    },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/pois/:id', auth: 'required', handler: poisDelete, summary: '刪除 POI',
    docs: {
      responses: {
        200: { description: '已刪除（連同 trip_entry_pois 關聯）', schema: S.Pois_DeleteResponse },
        400: err('id 格式錯誤（DATA_VALIDATION）'),
        401: E401,
        403: err('僅 ops:poi 維運 token 可刪除（PERM_DENIED）'),
        404: err('找不到此 POI（DATA_NOT_FOUND）'),
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/pois/:id/enrich', auth: 'required', handler: poisEnrichPost, summary: 'POI enrich',
    docs: {
      query: S.Pois_EnrichQuery,
      responses: {
        200: { description: '依 Google Place Details 更新後的狀態', schema: S.Pois_EnrichResponse },
        400: err('id 格式錯誤、非維運 token 缺 tripId，或 POI 沒有 place_id（DATA_VALIDATION）'),
        401: E401,
        403: err('沒有該行程的寫入權限，或 POI 不屬於該行程（PERM_DENIED）'),
        404: err('找不到此 POI（DATA_NOT_FOUND）'),
        502: E502,
        503: E503,
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/pois/find-or-create', auth: 'required', handler: poisFindOrCreatePost, summary: 'POI find-or-create',
    docs: {
      body: S.Pois_FindOrCreateBody,
      responses: {
        200: { description: 'POI id（新建與命中既有都是 200）', schema: S.Pois_FindOrCreateResponse },
        400: err('name 或 type 缺少或無效（DATA_VALIDATION）'),
        401: E401,
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/route', auth: 'none', handler: routeGet, summary: '路線（公開）',
    docs: {
      query: S.Pois_RouteQuery,
      responses: {
        200: { description: '開車路線（已解碼的 polyline）；Cache-Control 一天', schema: S.Pois_RouteResponse },
        400: err('from／to 不是範圍內的 lng,lat（DATA_VALIDATION）'),
        429: err('per-IP 請求過於頻繁（RATE_LIMITED）；帶 Retry-After'),
        502: E502,
        503: E503,
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/public-config', auth: 'none', handler: publicConfigGet, summary: '公開設定',
    docs: { responses: { 200: { description: '此部署啟用了哪些選用功能（不含任何 secret）；Cache-Control 60 秒', schema: S.Pois_PublicConfigResponse } } },
  });
}
