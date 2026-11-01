import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import type { LegacyRouteDocs } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as S from '../../schemas/days-entries';
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


const E = (description: string) => ({ description, schema: ApiError });
const ERR = {
  400: E('參數或 body 不合法（DATA_VALIDATION／DATA_ENCODING；另有 MISSING_MASTER：entry 還沒有正選 POI）'),
  401: E('沒有帶有效的 bearer token（AUTH_REQUIRED）'),
  403: E('沒有此行程的權限（PERM_DENIED），或目標資源不屬於此行程'),
  404: E('找不到行程／天／entry／POI（DATA_NOT_FOUND、POI_NOT_ALTERNATE）'),
  409: E('版本衝突或資料衝突（STALE_ENTRY：請重新讀取後再試；DUPLICATE_POI／DATA_CONFLICT：POI 已存在）'),
  422: E('備選順序不合法（INVALID_ORDER）'),
};
type Codes = Array<keyof typeof ERR>;
/** 成功回應 + 指定的錯誤碼（只列 handler 實際會回的）。 */
const docs = (
  ok: { status?: number; description: string; schema: import('@hono/zod-openapi').z.ZodTypeAny },
  errors: Codes,
  extra: Omit<LegacyRouteDocs, 'responses'> = {},
): LegacyRouteDocs => ({
  ...extra,
  responses: {
    [ok.status ?? 200]: { description: ok.description, schema: ok.schema },
    ...Object.fromEntries(errors.map((c) => [c, ERR[c]])),
  },
});

/**
 * 行程內容（days / entries）寫入端點。
 * 注意註冊順序：靜態段（shift、batch、reorder）必須在動態段（:num、:eid、:poiId）之前。
 * GET 一律 'optional'（已發布行程允許匿名讀取，handler 內以 requireTripReadAccess 把關）；寫入一律 'required'。
 */
export function registerDaysEntriesRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/days', auth: 'optional', summary: '列出行程的天（摘要，或 ?all=1 完整內容）', docs: docs({ description: '?all=1 回完整陣列，否則回摘要陣列', schema: S.DaysListResponse }, [401, 403, 404], { query: S.DaysListQuery }), handler: daysGet });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/days', auth: 'required', summary: '新增一天（最前／最後／依日期插入）', docs: docs({ description: '新增的那一天', schema: S.DayCreateResponse }, [400, 401, 403], { body: S.DaysCreateBody }), handler: daysPost });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/days/shift', auth: 'required', summary: '整體平移行程日期', docs: docs({ description: '平移結果', schema: S.DayShiftResponse }, [400, 401, 403], { body: S.DaysShiftBody }), handler: daysShiftPost });
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/days/:num', auth: 'optional', summary: '讀取單日完整內容', docs: docs({ description: '該天的飯店與 timeline', schema: S.DayFull }, [401, 403, 404]), handler: daysNumGet });
  legacyRoute(app, { method: 'put', path: '/api/trips/:id/days/:num', auth: 'required', summary: '整天覆寫（飯店＋timeline）', docs: docs({ description: '寫入完成，回新的 Day 版本', schema: S.DayReplaceResponse }, [400, 401, 403, 404, 409], { body: S.DayReplaceBody }), handler: daysNumPut });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/days/:num', auth: 'required', summary: '刪除一天（連同 entries，後面的天順位上移）', docs: docs({ description: '已刪除', schema: S.DayDeleteResponse }, [400, 401, 403, 404]), handler: daysNumDelete });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/days/:num/entries', auth: 'required', summary: '在指定天新增一個 entry（含正選 POI）', docs: docs({ status: 201, description: '新增的 entry 資料列', schema: S.EntryRow }, [400, 401, 403, 404], { body: S.EntryCreateBody }), handler: daysNumEntriesPost });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/batch', auth: 'required', summary: '批次更新多個 entry 的排序／所屬天／時間', docs: docs({ description: '已更新的筆數', schema: S.EntriesBatchResponse }, [400, 401, 403, 404], { body: S.EntriesBatchBody }), handler: entriesBatchPatch });
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/entries/:eid', auth: 'optional', summary: '讀取單一 entry（含正選／備選 POI）', docs: docs({ description: 'entry 與其 POI', schema: S.EntryDetail }, [400, 401, 403, 404]), handler: entryGet });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid', auth: 'required', summary: '部分更新 entry（時間／排序／跨天移動／說明）', docs: docs({ description: '更新後的 entry 資料列（sortOrder 為重排前的值）', schema: S.EntryRow }, [400, 401, 403, 404, 409], { body: S.EntryPatchBody }), handler: entryPatch });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/entries/:eid', auth: 'required', summary: '刪除 entry', docs: docs({ description: '已刪除', schema: S.Ok }, [400, 401, 403, 404]), handler: entryDelete });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/entries/:eid/alternates', auth: 'required', summary: '新增備選 POI', docs: docs({ status: 201, description: '新備選與最新的 entryPoisVersion', schema: S.AlternateAddResponse }, [400, 401, 403, 404, 409], { body: S.AlternateAddBody }), handler: alternatesPost });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid/alternates/reorder', auth: 'required', summary: '重新排序備選 POI', docs: docs({ description: '新順序與最新的 entryPoisVersion', schema: S.AlternateReorderResponse }, [400, 401, 403, 404, 409, 422], { body: S.AlternateReorderBody }), handler: alternatesReorderPatch });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/entries/:eid/alternates/:poiId', auth: 'required', summary: '移除備選 POI（不可移除正選）', docs: docs({ description: '已移除，回最新的 entryPoisVersion', schema: S.AlternateRemoveResponse }, [400, 401, 403, 404, 409], { query: S.AlternateDeleteQuery }), handler: alternateDelete });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/entries/:eid/copy', auth: 'required', summary: '複製 entry 到同行程的另一天', docs: docs({ description: '新建立的 entry 資料列（狀態碼是 200，不是 201）', schema: S.EntryRow }, [400, 401, 403, 404], { body: S.EntryCopyBody }), handler: entryCopyPost });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid/master', auth: 'required', summary: '設定或更換正選 POI', docs: docs({ description: '新舊正選與最新的 entryPoisVersion', schema: S.EntryMasterResponse }, [400, 401, 403, 404, 409], { body: S.EntryMasterBody }), handler: entryMasterPatch });
  legacyRoute(app, { method: 'put', path: '/api/trips/:id/entries/:eid/poi-id', auth: 'required', summary: '把正選 POI 換成指定的或新建的 POI', docs: docs({ description: '換上的 POI id', schema: S.PoiIdReplaceResponse }, [400, 401, 403, 404, 409], { body: S.PoiIdReplaceBody }), handler: entryPoiIdPut });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/entries/:eid/pois/:poiId', auth: 'required', summary: '編輯 entry 底下某個 POI 的備註／訂位／分類', docs: docs({ description: '更新後的狀態（改分類時 poiId 可能不同於路徑上的值）', schema: S.EntryPoiPatchResponse }, [400, 401, 403, 404], { body: S.EntryPoiPatchBody }), handler: entryPoiPatch });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/entries/:eid/trip-pois', auth: 'required', summary: '新增一個 POI 到 entry（成為備選）', docs: docs({ status: 201, description: '新增的 trip_entry_pois 資料列', schema: S.EntryPoiRow }, [400, 401, 403, 409], { body: S.EntryTripPoiBody }), handler: entryTripPoisPost });
}
