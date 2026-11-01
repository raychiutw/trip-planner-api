import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
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
 * 其餘一律 'required'。companion 的路徑白名單屬舊 middleware，由 requests-ops 組實作。
 */
export function registerPoisPlacesRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'post', path: '/api/places/autocomplete', auth: 'required', handler: placesAutocompletePost, summary: 'Places 自動完成' });
  legacyRoute(app, { method: 'get', path: '/api/places/resolve', auth: 'required', handler: placesResolveGet, summary: 'Places 解析' });
  legacyRoute(app, { method: 'get', path: '/api/poi-favorites', auth: 'required', handler: poiFavoritesGet, summary: '收藏列表' });
  legacyRoute(app, { method: 'post', path: '/api/poi-favorites', auth: 'required', handler: poiFavoritesPost, summary: '新增收藏' });
  legacyRoute(app, { method: 'delete', path: '/api/poi-favorites/:id', auth: 'required', handler: poiFavoritesDelete, summary: '刪除收藏' });
  legacyRoute(app, { method: 'post', path: '/api/poi-favorites/:id/add-to-trip', auth: 'required', handler: poiFavoritesAddToTrip, summary: '收藏加入行程' });
  legacyRoute(app, { method: 'get', path: '/api/poi-search', auth: 'none', handler: poiSearchGet, summary: 'POI 搜尋（公開）' });
  legacyRoute(app, { method: 'patch', path: '/api/pois/:id', auth: 'required', handler: poisPatch, summary: '更新 POI' });
  legacyRoute(app, { method: 'delete', path: '/api/pois/:id', auth: 'required', handler: poisDelete, summary: '刪除 POI' });
  legacyRoute(app, { method: 'post', path: '/api/pois/:id/enrich', auth: 'required', handler: poisEnrichPost, summary: 'POI enrich' });
  legacyRoute(app, { method: 'post', path: '/api/pois/find-or-create', auth: 'required', handler: poisFindOrCreatePost, summary: 'POI find-or-create' });
  legacyRoute(app, { method: 'get', path: '/api/route', auth: 'none', handler: routeGet, summary: '路線（公開）' });
  legacyRoute(app, { method: 'get', path: '/api/public-config', auth: 'none', handler: publicConfigGet, summary: '公開設定' });
}
