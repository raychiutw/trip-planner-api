/**
 * GET /api/requests?tripId=xxx&status=open&limit=10&sort=desc&before=<created_at>&beforeId=<id>&after=<created_at>&afterId=<id>
 * POST /api/requests { tripId, mode, message }
 *   (legacy fallback: title + body → message)
 *
 * 分頁：cursor-based
 *   - limit: 每頁筆數（預設 10，最大 50）
 *   - sort: asc | desc（預設 desc）
 *   - before/beforeId: 往舊方向 cursor（DESC 模式）
 *   - after/afterId: 往舊方向 cursor（ASC 模式，用於聊天式列表向上載入）
 *   - 回傳 { items: [...], hasMore: boolean }
 *   - 不帶 limit/before/after 時向下相容（回傳全部，LIMIT 50）
 */

import { logAudit, recordEmailEvent } from '../../lib/audit';
import { alertAdminTelegram } from '../../lib/alert';
import { hasPermission, requireAuth, hasOpsScope, requireTripWrite } from '../../lib/permissions';
import { AppError } from '../../errors';
import { json, parseJsonBody } from '../../lib/utils';
import type { Env } from '../../env';

// GET /api/requests
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const auth = requireAuth(context);
  const url = new URL(request.url);
  const tripId = url.searchParams.get('tripId');
  const status = url.searchParams.get('status');
  const limitParam = url.searchParams.get('limit');
  const sort = url.searchParams.get('sort') === 'asc' ? 'asc' : 'desc';
  const before = url.searchParams.get('before');
  const beforeId = url.searchParams.get('beforeId');
  const after = url.searchParams.get('after');
  const afterId = url.searchParams.get('afterId');

  // service token 帶 ops:trips:read 可不帶 tripId 查詢所有 requests（Phase 1）
  if (!tripId && !hasOpsScope(auth, 'ops:trips:read')) {
    throw new AppError('DATA_VALIDATION', '缺少 tripId 參數');
  }

  if (tripId && !await hasPermission(env.DB, auth, tripId)) {
    throw new AppError('PERM_DENIED');
  }

  const isPaginated = limitParam !== null || before !== null || after !== null;
  const limit = Math.min(Math.max(parseInt(limitParam || '10', 10) || 10, 1), 50);

  // 2026-05-07：LEFT JOIN users 取 submitted_by → users.display_name 給 chat
  // avatar / sender label 用「帳號名稱」第一字母（不是 email）。submitted_by
  // 是 email；users.email 唯一索引；找不到 → display_name=null fallback 到 email。
  let sql = 'SELECT r.*, u.display_name AS submitted_by_display_name FROM trip_requests r LEFT JOIN users u ON u.email = r.submitted_by';
  const params: (string | number)[] = [];
  const conditions: string[] = [];

  if (tripId) {
    conditions.push('r.trip_id = ?');
    params.push(tripId);
  }
  if (status) {
    conditions.push('r.status = ?');
    params.push(status);
  }
  if (before) {
    if (beforeId) {
      conditions.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      params.push(before, before, parseInt(beforeId, 10) || 0);
    } else {
      conditions.push('r.created_at < ?');
      params.push(before);
    }
  }
  if (after) {
    // v2.33.42 fix: 之前 after/afterId 用 `<` (與 before 同向)，sort=asc 拿到的
    // page 是錯方向 — `after` 邏輯該對應「比此 cursor 新」即 `>`。
    if (afterId) {
      conditions.push('(r.created_at > ? OR (r.created_at = ? AND r.id > ?))');
      params.push(after, after, parseInt(afterId, 10) || 0);
    } else {
      conditions.push('r.created_at > ?');
      params.push(after);
    }
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  if (sort === 'asc') {
    sql += ' ORDER BY r.created_at ASC, r.id ASC';
  } else {
    sql += ' ORDER BY r.created_at DESC, r.id DESC';
  }
  sql += isPaginated ? ` LIMIT ${limit + 1}` : ' LIMIT 50';

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  if (isPaginated) {
    const hasMore = (results ?? []).length > limit;
    const items = hasMore ? (results ?? []).slice(0, limit) : (results ?? []);
    return json({ items, hasMore });
  }

  // 向下相容：不帶分頁參數時回傳陣列
  return json(results);
};

// POST /api/requests
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const auth = requireAuth(context);

  type RequestBody = { tripId?: string; mode?: string; message?: string; title?: string; body?: string };
  const body = await parseJsonBody<RequestBody>(request);

  const { tripId } = body;
  // 優先使用 message，若未提供則 fallback 合併 title + body（向下相容）
  const message = body.message
    || [body.title, body.body].filter(Boolean).join('\n')
    || '';

  if (!tripId || !message) {
    throw new AppError('DATA_VALIDATION', '缺少必要欄位：tripId, message');
  }

  // mode is vestigial (migration 0048 phase 1 nullable; phase 2 will DROP COLUMN).
  await requireTripWrite(env.DB, auth, tripId);

  // 30 秒去重保護：防止因網路重試或使用者重複點擊造成重複寫入。
  // 只去重「仍在跑」的請求（open/processing）——終結狀態（failed/completed）不得遮蔽合法重送：
  // 未授權請求被 mint-restricted park 成 failed 後，owner 授權→重送同一訊息若撞回那筆 failed
  // 會綁到死 id、SSE 立刻回 failed，授權後的第一次重送看似又失敗（adversarial F1）。
  const existing = await env.DB
    .prepare(
      'SELECT * FROM trip_requests WHERE trip_id = ? AND message = ? AND submitted_by = ? AND status IN (\'open\', \'processing\') AND created_at > datetime(\'now\', \'-30 seconds\') ORDER BY created_at DESC LIMIT 1'
    )
    .bind(tripId, message, auth.email)
    .first();

  if (existing) {
    // 已存在近期相同請求，回傳最新一筆（200 而非 201）
    return json(existing, 200);
  }

  const result = await env.DB
    .prepare(
      'INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING *'
    )
    .bind(tripId, message, auth.email)
    .first();

  const newRow = result as Record<string, unknown>;
  // logAudit 失敗不阻擋主流程，INSERT 已成功
  try {
    await logAudit(env.DB, {
      tripId,
      tableName: 'trip_requests',
      recordId: newRow ? (newRow.id as number) : null,
      action: 'insert',
      changedBy: auth.email,
      diffJson: JSON.stringify({ message: message.substring(0, 100) }),
    });
  } catch (auditErr) {
    console.error('[requests] logAudit failed (non-fatal):', auditErr);
  }

  // Fire-and-forget: 觸發 Mac Mini API server 處理（cron 5min 兜底）
  // 2026-05-02 silent-fail fix: 失敗時 audit_log + Telegram alert，不再 silent catch{}
  // (D1 audit 顯示 7 天 zero source=api → 既有 catch{} 完全掩蓋了 fetch 失敗)
  context.waitUntil(
    (async () => {
      const requestId = newRow ? (newRow as Record<string, unknown>).id : null;
      if (!env.TRIPLINE_API_URL) {
        await recordEmailEvent(env.DB, {
          template: 'trigger',
          recipient: 'system',
          status: 'config-missing',
          tripId,
          triggeredBy: auth.email,
          error: 'TRIPLINE_API_URL not configured',
        });
        await alertAdminTelegram(
          env,
          `即時觸發 config 缺失（cron 5min 兜底）: trip=${tripId}, request=${requestId} (TRIPLINE_API_URL not set)`,
        );
        return;
      }
      try {
        const ctrl = new AbortController();
        // v2.33.113: 3000 → 8000ms — CF edge → Tailscale Funnel cold connection
        // (DNS + TCP + TLS handshake from a CF colo first-touch / post-idle)
        // 偶爾 4-5s，3s 必 abort → Telegram 噪音 alert（如 request 210 2026-05-25
        // 15:57 UTC：實測 INSERT 到 mac mini 收到 /trigger 4.978s）。8s 涵蓋 99%
        // cold path；request 仍由 5min cron 兜底保證最終一致性。
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(env.TRIPLINE_API_URL + '/trigger?source=api', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.TRIPLINE_API_SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requestId }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          // Inner control-flow throw — 立即被下方 catch 抓並 recordEmailEvent
          // log；非 AppError 因不對外回應（fire-and-forget background task）。
          throw new Error(`Trigger responded ${res.status}`);
        }
        // 成功不寫 audit — trigger 量大，正常情況無需 trail
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordEmailEvent(env.DB, {
          template: 'trigger',
          recipient: 'system',
          status: 'trigger-failed',
          tripId,
          triggeredBy: auth.email,
          error: msg,
        });
        await alertAdminTelegram(
          env,
          `即時觸發失敗（cron 5min 兜底）: trip=${tripId}, request=${requestId} (${msg})`,
        );
      }
    })(),
  );

  return json(result, 201);
};
