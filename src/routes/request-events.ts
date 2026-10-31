/**
 * 請求狀態的即時推送（SSE）。
 * - POST /api/requests/:id/sse-ticket：用 access token 換一次性 ticket。
 * - GET  /api/requests/:id/events：`?ticket=` 兌換，或直接帶 Authorization（能附標頭的 client，如 Flutter）。
 *
 * 串流中途憑證到期／被撤銷／權限被拿掉，或達最長時間時，送 `event: reconnect`（含 reason）後關閉；
 * client 重新換 ticket、帶 Last-Event-ID 重連即可接續（狀態相同就不重送）。
 * 不 log 網址或憑證；ticket 失敗一律同一個 401。
 *
 * 給 client 的注意：
 * - 原生 EventSource 的自動重連會重送同一個（已用過的）ticket 而收到 401 後停止；
 *   要接續，client 必須監聽 `reconnect` 事件、重新換 ticket 再連（帶 Last-Event-ID）。
 * - ticket 放在 query string，反向代理／Cloudflare 的存取記錄可能含網址；緩解是 30 秒、單次、綁定 request。
 *   能附標頭的 client 請直接用 Authorization 連線，完全避開這個殘餘風險。
 * - Last-Event-ID 是「狀態快照」語意（不是事件日誌）：連續變更的中間態可能被合併，最終狀態不會漏。
 */
import type { Hono } from 'hono';
import { AppError, buildRateLimitResponse, errorResponse } from '../errors';
import { bearerAuth, requireAuth } from '../auth';
import type { AppEnv } from '../env';
import type { AuthData } from '../types';
import { hasPermission } from '../lib/permissions';
import { bumpRateLimit, checkRateLimit } from '../lib/rate-limit';
import { D1Adapter } from '../lib/oauth-d1-adapter';
import { issueSseTicket, redeemSseTicket, SSE_TICKET_TTL_SEC, type SseGrant } from '../lib/sse-ticket';
import { ERROR_MESSAGES } from '../types';

export interface SseTimings { pollMs: number; keepaliveMs: number; maxMs: number }
export const DEFAULT_SSE_TIMINGS: SseTimings = { pollMs: 10_000, keepaliveMs: 25_000, maxMs: 30 * 60 * 1000 };
const TICKET_RATE = { maxAttempts: 30, windowMs: 60_000, lockoutMs: 60_000 };

const notFound = () => errorResponse(new AppError('DATA_NOT_FOUND'));
const unauthorized = () => errorResponse(new AppError('AUTH_REQUIRED'));

type ReconnectReason = 'token_expired' | 'grant_revoked' | 'max_duration';

/** 使用者仍有效、仍有行程權限、憑證所屬的 grant 仍有未過期的 access token。 */
async function stillAuthorized(db: D1Database, p: SseGrant): Promise<boolean> {
  const row = await db.prepare(
    `SELECT
       (SELECT 1 FROM users WHERE id = ? AND status = 'active') AS usr,
       (SELECT 1 FROM trip_permissions WHERE user_id = ? AND trip_id = ?) AS perm,
       (SELECT 1 FROM oauth_models WHERE name = 'AccessToken' AND json_extract(payload, '$.grantId') = ? AND expires_at > ?) AS grant_ok`,
  ).bind(p.userId, p.userId, p.tripId, p.grantId, Date.now()).first<{ usr: number | null; perm: number | null; grant_ok: number | null }>();
  return !!row && row.usr === 1 && row.perm === 1 && row.grant_ok === 1;
}

/** 目前 access token 的 grant 與到期時間（用於決定串流最晚時間）；走 adapter，過期的視為不存在。 */
async function tokenInfo(db: D1Database, token: string): Promise<{ grantId: string; expiresAt: number } | null> {
  const found = await new D1Adapter(db, 'AccessToken').findWithExpiry(token);
  const grantId = found?.payload.grantId;
  return found && typeof grantId === 'string' ? { grantId, expiresAt: found.expiresAt } : null;
}

const parseRequestId = (id: string): string | null => (/^\d{1,15}$/.test(id) ? id : null);

/**
 * 換票與直連共用的前置：request 存在且呼叫者有行程權限，並取得憑證的 grant／到期時間。
 * 「不存在」與「沒權限」同一個 404（不洩漏 request 是否存在）；憑證資訊缺失 → 401。
 */
async function loadAuthorizedGrant(
  db: D1Database, auth: AuthData, requestId: string, accessToken: string, maxMs: number,
): Promise<SseGrant | Response> {
  const req = await db.prepare('SELECT trip_id FROM trip_requests WHERE id = ?').bind(requestId).first<{ trip_id: string }>();
  if (!req || !(await hasPermission(db, auth, req.trip_id))) return notFound();
  const info = await tokenInfo(db, accessToken);
  if (!info || !auth.userId) return unauthorized();
  return { requestId, tripId: req.trip_id, userId: auth.userId, grantId: info.grantId, until: Math.min(info.expiresAt, Date.now() + maxMs) };
}

function eventId(row: { status: string; processed_by: string | null; updated_at: string | null }): string {
  return `${row.updated_at ?? ''}|${row.status}|${row.processed_by ?? ''}`.replace(/[\r\n]/g, ' ');
}

function openStream(db: D1Database, p: SseGrant, lastEventId: string, t: SseTimings): Response {
  const enc = new TextEncoder();
  let stopped = false;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const write = (s: string) => { if (!stopped) controller.enqueue(enc.encode(s)); };
      const finish = (reconnectReason?: ReconnectReason) => {
        if (stopped) return;
        if (reconnectReason) write(`event: reconnect\ndata: ${JSON.stringify({ reason: reconnectReason })}\n\n`);
        stopped = true;
        try { controller.close(); } catch { /* 已關閉 */ }
      };
      const sleep = (ms: number) => new Promise<void>((r) => { wake = r; timer = setTimeout(r, ms); });

      const startedAt = Date.now();
      let lastId = lastEventId;
      let lastWrite = Date.now();

      while (!stopped) {
        const now = Date.now();
        if (now >= p.until) return finish('token_expired');
        if (now - startedAt >= t.maxMs) return finish('max_duration');
        try {
          if (!(await stillAuthorized(db, p))) return finish('grant_revoked');
          const row = await db.prepare('SELECT status, processed_by, updated_at FROM trip_requests WHERE id = ?')
            .bind(p.requestId).first<{ status: string; processed_by: string | null; updated_at: string | null }>();
          if (!row) { write('data: {"error":"not_found"}\n\n'); return finish(); }
          const id = eventId(row);
          if (id !== lastId) {
            lastId = id;
            write(`id: ${id}\ndata: ${JSON.stringify({ status: row.status, processedBy: row.processed_by, updatedAt: row.updated_at })}\n\n`);
            lastWrite = Date.now();
          }
          if (row.status === 'completed' || row.status === 'failed') return finish();
        } catch {
          // 暫時性錯誤：下一輪再試（串流仍受 until／maxMs 限制）
        }
        if (Date.now() - lastWrite >= t.keepaliveMs) { write(': ping\n\n'); lastWrite = Date.now(); }
        await sleep(Math.min(t.pollMs, Math.max(1, p.until - Date.now())));
      }
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
}

export function registerRequestEventsRoutes(app: Hono<AppEnv>, timings: SseTimings): void {
  app.post('/api/requests/:id/sse-ticket', bearerAuth, requireAuth, async (c) => {
    const id = parseRequestId(c.req.param('id'));
    if (!id) return notFound();
    const auth = c.get('auth')!;
    const db = c.env.DB;

    const rlKey = `sse-ticket:${auth.userId ?? auth.email}`;
    const rl = await checkRateLimit(db, rlKey, TICKET_RATE);
    if (!rl.ok) return buildRateLimitResponse(rl.retryAfter ?? 60, { error: { code: 'SYS_RATE_LIMIT', message: ERROR_MESSAGES.SYS_RATE_LIMIT } });
    await bumpRateLimit(db, rlKey, TICKET_RATE);

    const grant = await loadAuthorizedGrant(db, auth, id, c.get('accessToken') ?? '', timings.maxMs);
    if (grant instanceof Response) return grant;
    return c.json({ ticket: await issueSseTicket(db, grant), expires_in: SSE_TICKET_TTL_SEC }, 200, { 'Cache-Control': 'no-store' });
  });

  app.get('/api/requests/:id/events', bearerAuth, async (c) => {
    const id = parseRequestId(c.req.param('id'));
    if (!id) return notFound();
    const db = c.env.DB;
    const lastEventId = c.req.header('Last-Event-ID') ?? '';

    const ticket = c.req.query('ticket');
    if (ticket !== undefined) {
      const grant = await redeemSseTicket(db, ticket);
      if (!grant || grant.requestId !== id || grant.until <= Date.now()) return unauthorized();
      if (!(await stillAuthorized(db, grant))) return unauthorized();
      return openStream(db, grant, lastEventId, timings);
    }

    const auth = c.get('auth');
    if (!auth || !auth.userId) return unauthorized();
    const grant = await loadAuthorizedGrant(db, auth, id, c.get('accessToken') ?? '', timings.maxMs);
    if (grant instanceof Response) return grant;
    return openStream(db, grant, lastEventId, timings);
  });
}
