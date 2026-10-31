/**
 * SSE 一次性 ticket。EventSource 無法附認證標頭，所以向 api 換 ticket：
 * 30 秒有效、綁定單一 request 與換取者、兌換即刪除（用過即失效）。
 * 資料庫只存 SHA-256 雜湊；ticket 明文只存在於回應與 client 手上。
 */
import { generateOpaqueToken, sha256Base64Url } from './crypto';

export const SSE_TICKET_TTL_SEC = 30;
const SSE_TICKET_MODEL = 'SseTicket';
const MAX_TICKET_LENGTH = 128;

/** ticket 與串流共用的授權範圍：誰、看哪個 request、憑證（grant）是哪個、最晚到何時。 */
export interface SseGrant {
  requestId: string;
  tripId: string;
  userId: string;
  grantId: string;
  /** 串流最晚到這個時間（unix ms）：換取時 access token 的到期時間與最長串流時間取小。 */
  until: number;
}

export async function issueSseTicket(db: D1Database, grant: SseGrant): Promise<string> {
  const ticket = generateOpaqueToken(32);
  await db
    .prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)')
    .bind(SSE_TICKET_MODEL, await sha256Base64Url(ticket), JSON.stringify(grant), Date.now() + SSE_TICKET_TTL_SEC * 1000)
    .run();
  return ticket;
}

/** 兌換：原子地刪除並取回；不存在、過期、已用過都回 null。 */
export async function redeemSseTicket(db: D1Database, ticket: string): Promise<SseGrant | null> {
  if (!ticket || ticket.length > MAX_TICKET_LENGTH) return null;
  const row = await db
    .prepare('DELETE FROM oauth_models WHERE name = ? AND id = ? AND expires_at >= ? RETURNING payload')
    .bind(SSE_TICKET_MODEL, await sha256Base64Url(ticket), Date.now())
    .first<{ payload: string }>();
  if (!row) return null;
  try {
    const g = JSON.parse(row.payload) as Partial<SseGrant>;
    return typeof g.requestId === 'string' && typeof g.tripId === 'string' && typeof g.userId === 'string'
      && typeof g.grantId === 'string' && typeof g.until === 'number' ? (g as SseGrant) : null;
  } catch {
    return null;
  }
}
