import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as notesAggregateGet } from '../handlers/trips/@id/notes';
import { onRequestGet as aiStateGet } from '../handlers/trips/@id/notes/ai-state';
import { onRequestPatch as maintenancePatch } from '../handlers/trips/@id/notes/@section/@rowId/maintenance';
import { onRequestGet as exclusionsGet } from '../handlers/trips/@id/notes/@type/exclusions/index';
import { onRequestDelete as exclusionDelete } from '../handlers/trips/@id/notes/@type/exclusions/@exclusionId';
import { onRequestPost as generatePost } from '../handlers/trips/@id/notes/@type/generate';
import * as emergency from '../handlers/trips/@id/notes/emergency';
import * as emergencyRow from '../handlers/trips/@id/notes/emergency/@rowId';
import * as emergencyReorder from '../handlers/trips/@id/notes/emergency/reorder';
import * as flights from '../handlers/trips/@id/notes/flights';
import * as flightsRow from '../handlers/trips/@id/notes/flights/@rowId';
import * as flightsReorder from '../handlers/trips/@id/notes/flights/reorder';
import * as lodgings from '../handlers/trips/@id/notes/lodgings';
import * as lodgingsRow from '../handlers/trips/@id/notes/lodgings/@rowId';
import * as lodgingsReorder from '../handlers/trips/@id/notes/lodgings/reorder';
import * as pretrip from '../handlers/trips/@id/notes/pretrip';
import * as pretripRow from '../handlers/trips/@id/notes/pretrip/@rowId';
import * as pretripReorder from '../handlers/trips/@id/notes/pretrip/reorder';
import * as reservations from '../handlers/trips/@id/notes/reservations';
import * as reservationsRow from '../handlers/trips/@id/notes/reservations/@rowId';
import * as reservationsReorder from '../handlers/trips/@id/notes/reservations/reorder';

/**
 * 五種筆記區段，每種同一組 handler（list/create、reorder、單列 patch/delete）。
 * 舊 middleware 沒有任何筆記路徑是公開讀取，且所有 handler 都 requireAuth + hasPermission
 * （GET 也不允許匿名），所以全部 'required'。
 */
const SECTIONS = [
  { name: 'emergency', label: '緊急聯絡', list: emergency, row: emergencyRow, reorder: emergencyReorder },
  { name: 'flights', label: '航班', list: flights, row: flightsRow, reorder: flightsReorder },
  { name: 'lodgings', label: '住宿', list: lodgings, row: lodgingsRow, reorder: lodgingsReorder },
  { name: 'pretrip', label: '行前須知', list: pretrip, row: pretripRow, reorder: pretripReorder },
  { name: 'reservations', label: '訂位', list: reservations, row: reservationsRow, reorder: reservationsReorder },
] as const;

/** 這一組的路由登記：行程筆記（五個區段 + AI 狀態／生成／排除項／維護）。 */
export function registerNotesRoutes(app: OpenAPIHono<AppEnv>): void {
  const base = '/api/trips/:id/notes';

  legacyRoute(app, { method: 'get', path: base, auth: 'required', handler: notesAggregateGet, summary: '行程筆記：五區段彙整' });
  legacyRoute(app, { method: 'get', path: `${base}/ai-state`, auth: 'required', handler: aiStateGet, summary: '行程筆記：AI 生成狀態' });

  for (const s of SECTIONS) {
    const p = `${base}/${s.name}`;
    legacyRoute(app, { method: 'get', path: p, auth: 'required', handler: s.list.onRequestGet, summary: `${s.label}：列表` });
    legacyRoute(app, { method: 'post', path: p, auth: 'required', handler: s.list.onRequestPost, summary: `${s.label}：新增` });
    // reorder 必須先於 /:rowId 登記，否則 "reorder" 會被當成 rowId
    legacyRoute(app, { method: 'patch', path: `${p}/reorder`, auth: 'required', handler: s.reorder.onRequestPatch, summary: `${s.label}：排序` });
    legacyRoute(app, { method: 'patch', path: `${p}/:rowId`, auth: 'required', handler: s.row.onRequestPatch, summary: `${s.label}：更新` });
    legacyRoute(app, { method: 'delete', path: `${p}/:rowId`, auth: 'required', handler: s.row.onRequestDelete, summary: `${s.label}：刪除` });
  }

  legacyRoute(app, { method: 'patch', path: `${base}/:section/:rowId/maintenance`, auth: 'required', handler: maintenancePatch, summary: '行程筆記：切換 AI／人工維護' });
  legacyRoute(app, { method: 'get', path: `${base}/:type/exclusions`, auth: 'required', handler: exclusionsGet, summary: '行程筆記：AI 排除項列表' });
  legacyRoute(app, { method: 'delete', path: `${base}/:type/exclusions/:exclusionId`, auth: 'required', handler: exclusionDelete, summary: '行程筆記：移除 AI 排除項' });
  legacyRoute(app, { method: 'post', path: `${base}/:type/generate`, auth: 'required', handler: generatePost, summary: '行程筆記：AI 生成' });
}
