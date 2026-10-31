/**
 * SSE 一次性 ticket。EventSource 無法附認證標頭，所以向 api 換 ticket：
 * 30 秒有效、綁定單一 request 與換取者、兌換即刪除（用過即失效）。
 * 資料庫只存 SHA-256 雜湊；ticket 明文只存在於回應與 client 手上。
 */
import { generateOpaqueToken } from './crypto';

export const SSE_TICKET_TTL_SEC = 30;
const MODEL = 'SseTicket';
const MAX_TICKET_LENGTH = 128;

export interface SseTicketPayload {
  request_id: string;
  trip_id: string;
  user_id: string;
  grant_id: string;
  /** 串流最晚到這個時間（unix ms）：換取時 access token 的到期時間與最長串流時間取小。 */
  until: number;
}

async function hashTicket(ticket: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket));
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function issueSseTicket(db: D1Database, payload: SseTicketPayload): Promise<string> {
  const ticket = generateOpaqueToken(32);
  await db
    .prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)')
    .bind(MODEL, await hashTicket(ticket), JSON.stringify(payload), Date.now() + SSE_TICKET_TTL_SEC * 1000)
    .run();
  return ticket;
}

/** 兌換：原子地刪除並取回；不存在、過期、已用過都回 null。 */
export async function redeemSseTicket(db: D1Database, ticket: string): Promise<SseTicketPayload | null> {
  if (!ticket || ticket.length > MAX_TICKET_LENGTH) return null;
  const row = await db
    .prepare('DELETE FROM oauth_models WHERE name = ? AND id = ? AND expires_at >= ? RETURNING payload')
    .bind(MODEL, await hashTicket(ticket), Date.now())
    .first<{ payload: string }>();
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload) as SseTicketPayload;
    return typeof p.request_id === 'string' && typeof p.trip_id === 'string' && typeof p.user_id === 'string'
      && typeof p.grant_id === 'string' && typeof p.until === 'number' ? p : null;
  } catch {
    return null;
  }
}
