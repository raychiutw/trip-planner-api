/**
 * GET /api/requests/:id
 * PATCH /api/requests/:id  { reply, status, processed_by }
 */

import { hasOpsScope, hasPermission, hasWritePermission, requireAuth } from '../../../../lib/permissions';
import { AppError } from '../../../../errors';
import { reapIfStale, updateRequest, type RequestPatch } from '../../../../lib/request-termination';
import { json, parseJsonBody } from '../../../../lib/utils';
import type { Env } from '../../../../env';

// GET /api/requests/:id
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, params } = context;
  const auth = requireAuth(context);
  const id = params.id as string;

  // 2026-05-07：LEFT JOIN users 取 display_name 給 chat avatar / sender label。
  const row = await env.DB
    .prepare('SELECT r.*, u.display_name AS submitted_by_display_name FROM trip_requests r LEFT JOIN users u ON u.email = r.submitted_by WHERE r.id = ?')
    .bind(id)
    .first();
  if (!row) throw new AppError('DATA_NOT_FOUND');

  const tripId = (row as Record<string, unknown>).trip_id as string;
  if (!await hasPermission(env.DB, auth, tripId)) {
    throw new AppError('PERM_DENIED');
  }

  // ADR-0007 第二層：牆鐘兜底。權限通過後才收 —— 收屍是寫入，不給沒權限的人觸發。
  // 收屍後的 row 少了 LEFT JOIN 的 submitted_by_display_name，補回去（chat avatar 要用）。
  const reaped = await reapIfStale(env.DB, id, row as Record<string, unknown>);
  if (reaped !== row) {
    reaped.submitted_by_display_name = (row as Record<string, unknown>).submitted_by_display_name;
  }

  return json(reaped);
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const { env, params } = context;
  const auth = requireAuth(context);
  const id = params.id as string;

  // gate 需要 request 的 trip_id 才能判斷 trip-writer → 提前 fetch（也供 status 驗證 +
  // audit diff 共用，只讀一次）。
  const oldRow = await env.DB.prepare('SELECT * FROM trip_requests WHERE id = ?').bind(id).first() as Record<string, unknown> | null;
  if (!oldRow) throw new AppError('DATA_NOT_FOUND', '找不到該請求');
  const requestTripId = oldRow.trip_id as string;

  // 授權：companion service token（Claude CLI 回覆 chat + 標記完成/失敗，跨-trip 可信）
  // 或 對該 request 所屬 trip 有寫權的 user（v2.55.56：restrict_trip-scoped tp-request
  // agent 只能回覆自己那個 trip 的請求 — status/reply 也吃 trip scope，比 companion
  // service token 更緊）。純維運 token（如僅 ops:maps）兩者皆不符 → 擋，不誤觸發 chat
  // 回覆 / health-check / notes hook。
  if (!hasOpsScope(auth, 'companion') && !(await hasWritePermission(env.DB, auth, requestTripId))) {
    throw new AppError('PERM_DENIED');
  }

  const body = await parseJsonBody<RequestPatch>(context.request);

  const result = await updateRequest(env.DB, oldRow, body, { changedBy: auth.email });
  return json(result);
};

export { sanitizeSchemaWords } from '../../../../lib/request-health-completion';
