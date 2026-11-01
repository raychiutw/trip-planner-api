import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as daysGet, onRequestPost as daysPost } from '../handlers/trips/@id/days';
import { onRequestPost as daysShiftPost } from '../handlers/trips/@id/days/shift';
import { onRequestGet as daysNumGet, onRequestPut as daysNumPut, onRequestDelete as daysNumDelete } from '../handlers/trips/@id/days/@num';
import { onRequestPost as daysNumEntriesPost } from '../handlers/trips/@id/days/@num/entries';
import { onRequestPatch as entriesBatchPatch } from '../handlers/trips/@id/entries/batch';
import { onRequestGet as entryGet, onRequestPatch as entryPatch, onRequestDelete as entryDelete } from '../handlers/trips/@id/entries/@eid';
import { onRequestPost as alternatesPost } from '../handlers/trips/@id/entries/@eid/alternates';
import { onRequestPatch as alternatesReorderPatch } from '../handlers/trips/@id/entries/@eid/alternates/reorder';
import { onRequestDelete as alternateDelete } from '../handlers/trips/@id/entries/@eid/alternates/@poiId';
import { onRequestPost as entryCopyPost } from '../handlers/trips/@id/entries/@eid/copy';
import { onRequestPatch as entryMasterPatch } from '../handlers/trips/@id/entries/@eid/master';
import { onRequestPut as entryPoiIdPut } from '../handlers/trips/@id/entries/@eid/poi-id';
import { onRequestPatch as entryPoiPatch } from '../handlers/trips/@id/entries/@eid/pois/@poiId';
import { onRequestPost as entryTripPoisPost } from '../handlers/trips/@id/entries/@eid/trip-pois';

/**
 * 行程內容（days / entries）寫入端點。
 * 注意註冊順序：靜態段（shift、batch、reorder）必須在動態段（:num、:eid、:poiId）之前。
 * GET 一律 'optional'（已發布行程允許匿名讀取，handler 內以 requireTripReadAccess 把關）；寫入一律 'required'。
 */
export function registerDaysEntriesRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/days', auth: 'optional', handler: daysGet });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/days', auth: 'required', handler: daysPost });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/days/shift', auth: 'required', handler: daysShiftPost });
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/days/:num', auth: 'optional', handler: daysNumGet });
  legacyRoute(app, { method: 'put', path: '/api/trips/:id/days/:num', auth: 'required', handler: daysNumPut });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/days/:num', auth: 'required', handler: daysNumDelete });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/days/:num/entries', auth: 'required', handler: daysNumEntriesPost });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/batch', auth: 'required', handler: entriesBatchPatch });
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/entries/:eid', auth: 'optional', handler: entryGet });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid', auth: 'required', handler: entryPatch });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/entries/:eid', auth: 'required', handler: entryDelete });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/entries/:eid/alternates', auth: 'required', handler: alternatesPost });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid/alternates/reorder', auth: 'required', handler: alternatesReorderPatch });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/entries/:eid/alternates/:poiId', auth: 'required', handler: alternateDelete });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/entries/:eid/copy', auth: 'required', handler: entryCopyPost });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid/master', auth: 'required', handler: entryMasterPatch });
  legacyRoute(app, { method: 'put', path: '/api/trips/:id/entries/:eid/poi-id', auth: 'required', handler: entryPoiIdPut });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid/pois/:poiId', auth: 'required', handler: entryPoiPatch });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/entries/:eid/trip-pois', auth: 'required', handler: entryTripPoisPost });
}
