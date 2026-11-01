/**
 * Auth audit log helper — V2-P6
 *
 * 集中記錄 OAuth / 帳密 / session 事件供 monitoring + forensic。
 * 所有 caller 透過 `recordAuthEvent()` 寫，**best-effort**：audit failure
 * 不該擋 caller 業務流程（例如 audit DB 滿了不能阻止使用者登入）。
 *
 * Schema 詳見 `migrations/0036_auth_audit_log.sql`。
 *
 * ## Usage
 *
 * ```ts
 * await recordAuthEvent(context.env.DB, context.request, {
 *   eventType: 'login',
 *   outcome: 'failure',
 *   failureReason: 'wrong_password',
 *   userId: identity?.user_id,  // optional, undefined if email not found
 * });
 * ```
 */
import type { D1Database } from '@cloudflare/workers-types';
import { sha256Base64 } from './crypto';

/**
 * v2.33.62 round 14c: HMAC-based IP hash if SESSION_IP_HASH_SECRET set,
 * fallback to SHA-256 for backward compat。
 *
 * Background: SHA-256(IP) 是 unsalted，IPv4 4B 空間 rainbow-table-reversible 幾小時
 * (per migrations/0036 acknowledgment)。HMAC with secret key 防 dump-then-reverse —
 * 攻擊者需同時拿 DB dump + env SECRET。
 *
 * 部署: wrangler env set SESSION_IP_HASH_SECRET <32-byte-random-base64>。
 * Set 後新 row HMAC，old SHA-256 row 在 30-day retention 後自然消失。
 */
async function hashIp(env: { SESSION_IP_HASH_SECRET?: string }, ip: string): Promise<string> {
  const secret = env.SESSION_IP_HASH_SECRET;
  if (!secret || secret.length === 0) {
    return sha256Base64(ip); // backward compat
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  const bytes = new Uint8Array(sig);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str);
}

export type AuthEventType =
  | 'signup'
  | 'login'
  | 'logout'
  | 'password_reset_request'
  | 'password_reset_complete'
  | 'oauth_authorize'
  | 'oauth_consent'
  | 'token_issue'
  | 'token_revoke'
  | 'rate_limited'
  | 'auth_failure'
  | 'permission_denied'
  | 'token_replay'
  | 'signature_error';

export type AuthEventOutcome = 'success' | 'failure';

export interface AuthAuditEvent {
  eventType: AuthEventType;
  outcome: AuthEventOutcome;
  userId?: string | null;
  clientId?: string | null;
  failureReason?: string | null;
  /** Free-form event-specific JSON serialised before INSERT. */
  metadata?: Record<string, unknown>;
  /** Correlation ID across multi-step OAuth flow (e.g. authorize → consent → token). */
  traceId?: string | null;
}

const USER_AGENT_MAX_LEN = 200;

/**
 * Record an auth event。**Never throws** — caller doesn't need try/catch。
 * Audit-write failure is logged via console.error 但不會影響 business flow。
 */
export async function recordAuthEvent(
  db: D1Database,
  request: Request,
  event: AuthAuditEvent,
  // v2.33.62 round 14c: env optional — 未傳 fallback unsalted SHA-256 (backward compat
  // for callers not yet migrated)。傳 env 走 HMAC if SESSION_IP_HASH_SECRET set。
  env?: { SESSION_IP_HASH_SECRET?: string },
): Promise<void> {
  try {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const ipHash = env ? await hashIp(env, ip) : await sha256Base64(ip);
    const userAgent = (request.headers.get('User-Agent') ?? '').slice(0, USER_AGENT_MAX_LEN);

    await db
      .prepare(
        `INSERT INTO auth_audit_log
           (trace_id, event_type, outcome, user_id, client_id, ip_hash, user_agent, failure_reason, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.traceId ?? null,
        event.eventType,
        event.outcome,
        event.userId ?? null,
        event.clientId ?? null,
        ipHash,
        userAgent || null,
        event.failureReason ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      )
      .run();
  } catch (err) {
    // best-effort — log but don't propagate
    // eslint-disable-next-line no-console
    console.error('[_auth_audit] recordAuthEvent failed:', (err as Error).message);
  }
}
