/**
 * 請求狀態的即時推送（SSE）。
 * - POST /api/requests/:id/sse-ticket：用 access token 換一次性 ticket。
 * - GET  /api/requests/:id/events：`?ticket=` 兌換，或直接帶 Authorization（能附標頭的 client，如 Flutter）。
 *
 * 串流中途憑證到期／被撤銷／權限被拿掉，或達最長時間時，送 `event: reconnect`（含 reason）後關閉；
 * client 重新換 ticket、帶 Last-Event-ID 重連即可接續（狀態相同就不重送）。
 * 不 log 網址或憑證；ticket 失敗一律同一個 401。
 */
import type { Hono } from 'hono';
import { AppError, buildRateLimitResponse, errorResponse } from '../errors';
import { bearerAuth, requireAuth } from '../auth';
import type { AppEnv } from '../env';
import { hasPermission } from '../lib/permissions';
import { bumpRateLimit, checkRateLimit } from '../lib/rate-limit';
import { issueSseTicket, redeemSseTicket, SSE_TICKET_TTL_SEC } from '../lib/sse-ticket';

export interface SseTimings { pollMs: number; keepaliveMs: number; maxMs: number }
export const DEFAULT_SSE_TIMINGS: SseTimings = { pollMs: 10_000, keepaliveMs: 25_000, maxMs: 30 * 60 * 1000 };
const TICKET_RATE = { maxAttempts: 30, windowMs: 60_000, lockoutMs: 60_000 };

const notFound = () => errorResponse(new AppError('DATA_NOT_FOUND'));
const unauthorized = () => errorResponse(new AppError('AUTH_REQUIRED'));

interface StreamParams { requestId: string; tripId: string; userId: string; grantId: string; until: number }

/** 使用者仍有效、仍有行程權限、憑證所屬的 grant 仍有未過期的 access token。 */
async function stillAuthorized(db: D1Database, p: StreamParams): Promise<boolean> {
  const row = await db.prepare(
    `SELECT
       (SELECT 1 FROM users WHERE id = ? AND status = 'active') AS usr,
       (SELECT 1 FROM trip_permissions WHERE user_id = ? AND trip_id = ?) AS perm,
       (SELECT 1 FROM oauth_models WHERE name = 'AccessToken' AND json_extract(payload, '$.grantId') = ? AND expires_at > ?) AS grant_ok`,
  ).bind(p.userId, p.userId, p.tripId, p.grantId, Date.now()).first<{ usr: number | null; perm: number | null; grant_ok: number | null }>();
  return !!row && row.usr === 1 && row.perm === 1 && row.grant_ok === 1;
}

/** 目前 access token 的 grant 與到期時間（用於決定串流最晚時間）。 */
async function tokenInfo(db: D1Database, token: string): Promise<{ grantId: string; expiresAt: number } | null> {
  const row = await db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'AccessToken' AND id = ?")
    .bind(token).first<{ payload: string; expires_at: number }>();
  if (!row) return null;
  try {
    const grantId = (JSON.parse(row.payload) as { grantId?: unknown }).grantId;
    return typeof grantId === 'string' ? { grantId, expiresAt: row.expires_at } : null;
  } catch {
    return null;
  }
}

function eventId(row: { status: string; processed_by: string | null; updated_at: string | null }): string {
  return `${row.updated_at ?? ''}|${row.status}|${row.processed_by ?? ''}`.replace(/[\r\n]/g, ' ');
}

function openStream(db: D1Database, p: StreamParams, lastEventId: string, t: SseTimings): Response {
  const enc = new TextEncoder();
  let stopped = false;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const write = (s: string) => { if (!stopped) controller.enqueue(enc.encode(s)); };
      const finish = (reconnectReason?: string) => {
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
    const id = c.req.param('id');
    if (!/^\d{1,15}$/.test(id)) return notFound();
    const auth = c.get('auth')!;
    const db = c.env.DB;

    const rlKey = `sse-ticket:${auth.userId ?? auth.email}`;
    const rl = await checkRateLimit(db, rlKey, TICKET_RATE);
    if (!rl.ok) return buildRateLimitResponse(rl.retryAfter ?? 60, { error: { code: 'SYS_RATE_LIMIT', message: '請求過於頻繁，請稍後再試' } });
    await bumpRateLimit(db, rlKey, TICKET_RATE);

    // 「不存在」與「沒權限」同一個 404，不洩漏 request 是否存在
    const req = await db.prepare('SELECT trip_id FROM trip_requests WHERE id = ?').bind(id).first<{ trip_id: string }>();
    if (!req || !(await hasPermission(db, auth, req.trip_id))) return notFound();
    const info = await tokenInfo(db, c.get('accessToken') ?? '');
    if (!info || !auth.userId) return unauthorized();

    const ticket = await issueSseTicket(db, {
      request_id: id, trip_id: req.trip_id, user_id: auth.userId, grant_id: info.grantId,
      until: Math.min(info.expiresAt, Date.now() + timings.maxMs),
    });
    return c.json({ ticket, expires_in: SSE_TICKET_TTL_SEC }, 200, { 'Cache-Control': 'no-store' });
  });

  app.get('/api/requests/:id/events', bearerAuth, async (c) => {
    const id = c.req.param('id');
    if (!/^\d{1,15}$/.test(id)) return notFound();
    const db = c.env.DB;
    const lastEventId = c.req.header('Last-Event-ID') ?? '';

    const ticket = c.req.query('ticket');
    if (ticket !== undefined) {
      const p = await redeemSseTicket(db, ticket);
      if (!p || p.request_id !== id || p.until <= Date.now()) return unauthorized();
      const params: StreamParams = { requestId: id, tripId: p.trip_id, userId: p.user_id, grantId: p.grant_id, until: p.until };
      if (!(await stillAuthorized(db, params))) return unauthorized();
      return openStream(db, params, lastEventId, timings);
    }

    const auth = c.get('auth');
    if (!auth || !auth.userId) return unauthorized();
    const req = await db.prepare('SELECT trip_id FROM trip_requests WHERE id = ?').bind(id).first<{ trip_id: string }>();
    if (!req || !(await hasPermission(db, auth, req.trip_id))) return notFound();
    const info = await tokenInfo(db, c.get('accessToken') ?? '');
    if (!info) return unauthorized();
    return openStream(db, {
      requestId: id, tripId: req.trip_id, userId: auth.userId, grantId: info.grantId,
      until: Math.min(info.expiresAt, Date.now() + timings.maxMs),
    }, lastEventId, timings);
  });
}
