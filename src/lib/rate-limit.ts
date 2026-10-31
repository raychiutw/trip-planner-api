/**
 * Rate limit middleware — V2-P6 brute force defence
 *
 * 用 D1 rate_limit_buckets table（migration 0035）做 sliding window + lockout。
 *
 * Usage:
 *   const result = await checkRateLimit(env, `login:${ip}`, {
 *     maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000,
 *   });
 *   if (!result.ok) {
 *     return new Response(null, {
 *       status: 429,
 *       headers: { 'Retry-After': String(result.retryAfter) },
 *     });
 *   }
 *
 * 失敗時 caller 自己 increment（成功 login 不該 count；失敗 login 才 count）。
 * 用法 pattern:
 *   1. checkRateLimit() before processing
 *   2. 若 process 成功 → resetRateLimit() 清 counter
 *   3. 若 process 失敗 → bumpRateLimit() count++
 */
import type { D1Database } from '@cloudflare/workers-types';

interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

interface RateLimitRow {
  bucket_key: string;
  count: number;
  window_start: number;
  locked_until: number | null;
}

export interface RateLimitResult {
  /** True if not currently locked + count within limit */
  ok: boolean;
  /** Seconds until next attempt allowed (only when ok=false) */
  retryAfter?: number;
  /** Current count in window */
  count?: number;
}

/**
 * Check rate limit for given bucket key。**Doesn't increment** — caller decides
 * when to bump (typically on failed attempt only)。
 */
export async function checkRateLimit(
  db: D1Database,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const now = Date.now();
  const row = await db
    .prepare('SELECT bucket_key, count, window_start, locked_until FROM rate_limit_buckets WHERE bucket_key = ?')
    .bind(key)
    .first<RateLimitRow>();

  if (!row) return { ok: true, count: 0 };

  // Locked?
  if (row.locked_until && row.locked_until > now) {
    return { ok: false, retryAfter: Math.ceil((row.locked_until - now) / 1000) };
  }

  // Window expired? (count 視為 0 — bump 時會 reset window)
  if (row.window_start + config.windowMs < now) {
    return { ok: true, count: 0 };
  }

  return { ok: true, count: row.count };
}

/**
 * Increment rate limit count + maybe lock if exceeded。Call after a failed attempt。
 *
 * Atomic INSERT...ON CONFLICT 單 SQL upsert，避免 read-then-replace race
 * （poi-favorites-rename §3.3, design.md D16）。
 *
 * 語意保持與原 read-then-replace 完全相同：
 *   - new bucket → count=1, window_start=now, no lock
 *   - within window → count+1, window_start 不動
 *   - window expired → 重置 count=1, window_start=now, 清 lock
 *   - count+1 > maxAttempts 且 window 未過期 → 設 locked_until=now+lockoutMs
 *
 * Schema 沿用 0035 (rate_limit_buckets / window_start + locked_until)；
 * 沒有 expires_at 欄位，window 過期判斷用 window_start + windowMs < now。
 */
export async function bumpRateLimit(
  db: D1Database,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const now = Date.now();
  const lockExpiry = now + config.lockoutMs;

  const row = await db
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until)
       VALUES (?, 1, ?, NULL)
       ON CONFLICT(bucket_key) DO UPDATE
       SET
         count = CASE WHEN window_start + ? < ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start + ? < ? THEN ? ELSE window_start END,
         locked_until = CASE
           WHEN window_start + ? < ? THEN NULL
           WHEN count + 1 > ? THEN ?
           ELSE locked_until
         END
       RETURNING count, window_start, locked_until`,
    )
    .bind(
      key, now,
      config.windowMs, now,
      config.windowMs, now, now,
      config.windowMs, now,
      config.maxAttempts, lockExpiry,
    )
    .first<{ count: number; window_start: number; locked_until: number | null }>();

  if (!row) {
    // 防禦性 fallback：D1 INSERT...ON CONFLICT...RETURNING 在 production 永遠回 row。
    // null 主要出現在 mock-based unit test 沒實作 RETURNING 的情形 — 此時當 fresh
    // first-attempt 處理（count=1, no lock）保留語意連續性，不阻擋 caller 流程。
    return { ok: true, count: 1 };
  }

  if (row.locked_until && row.locked_until > now) {
    return { ok: false, retryAfter: Math.ceil((row.locked_until - now) / 1000), count: row.count };
  }
  return { ok: true, count: row.count };
}

/**
 * Reset counter on successful attempt — prevent legitimate user being locked
 * out from accumulated previous failures。
 */
export async function resetRateLimit(db: D1Database, key: string): Promise<void> {
  await db
    .prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?')
    .bind(key)
    .run();
}

/**
 * Extract client IP from CF-Connecting-IP header (Cloudflare adds this on edge)。
 * Fallback to 'unknown' so all attempts in dev share a bucket。
 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Common config presets */
export const RATE_LIMITS = {
  // Anti brute-force login: 5 attempts / 15min window, 30min lockout
  LOGIN: { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 30 * 60 * 1000 },
  // Signup spam protection: 10 attempts / 1h window, 1h lockout.
  // (Was 3/h per autoplan; bumped — too tight for dev self-testing + shared NAT IP)
  SIGNUP: { maxAttempts: 10, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // Password reset abuse: 3 attempts / 1h window, 1h lockout
  FORGOT_PASSWORD: { maxAttempts: 3, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // OAuth token endpoint per-client: 100 attempts / minute, 5min lockout
  OAUTH_TOKEN: { maxAttempts: 100, windowMs: 60 * 1000, lockoutMs: 5 * 60 * 1000 },
  // v2.33.103 SEC-7：OAuth token endpoint per-IP — 防 PBKDF2 amplification DoS。
  // Confidential client_secret 驗證走 PBKDF2 (100k iter ~50ms CPU)。Attacker
  // 用同 client_id 反覆送 wrong secret，per-client_id bucket 擋在 100/min 但
  // 前 100 個 request 已經燒 ~5s CPU。加 per-IP 50/min cap 提前擋掉。
  OAUTH_TOKEN_PER_IP: { maxAttempts: 50, windowMs: 60 * 1000, lockoutMs: 5 * 60 * 1000 },
  // Saved POI write per-user: 10/min window, locked until window end.
  // 防 POI enumeration oracle attack — too-fast POSTs probe non-existent poiId 404s.
  // lockoutMs must be > 0：當 newCount > maxAttempts 時 bumpRateLimit 才把 locked_until
  // 設成 now+lockoutMs，下一次 checkRateLimit 才能 reject。lockoutMs=0 會 collide with
  // bump 時間戳，rate limit 失效。set 60s 對齊 window 1 分鐘節奏。
  SAVED_POIS_WRITE: { maxAttempts: 10, windowMs: 60 * 1000, lockoutMs: 60 * 1000 },
  // POI favorites write per-user / per-companion-request: 10/min window, 60s lockout.
  // poi-favorites-rename §3.4 — 與 SAVED_POIS_WRITE 等值；handler 用兩個 bucket key
  // 形態：`poi-favorites-post:user:${userId}` 與 `poi-favorites-post:companion:${requestId}`，
  // 配合 D16 bucket 隔離防 companion 攻擊耗光 user web quota。
  POI_FAVORITES_WRITE: { maxAttempts: 10, windowMs: 60 * 1000, lockoutMs: 60 * 1000 },
  // v2.33.105 SEC-2：poi-favorites endpoints pre-gate per-IP throttle，防
  // unauthenticated attacker hammer requireFavoriteActor DB resolve（claim
  // trip_requests + SELECT users）。寬鬆設定（200/5min/IP），正常 user 完全
  // 不會打中（人類速度遠低於每秒 1 個 favorite）；攻擊者 100 個 concurrent
  // POST 觸 lock。
  POI_FAVORITES_PRE_GATE_IP: { maxAttempts: 200, windowMs: 5 * 60 * 1000, lockoutMs: 5 * 60 * 1000 },
  // v2.33.42 security audit: public anonymous endpoints — 防 paid quota DoS.
  // 200/24h per IP 對 normal user 完全沒影響但能擋自動化 scanner。
  REPORTS_PER_IP: { maxAttempts: 200, windowMs: 24 * 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // Google Routes API ~$5/1000 — 嚴一點。
  ROUTE_PER_IP: { maxAttempts: 100, windowMs: 24 * 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // Google Places Text Search ~$32/1000 — 最嚴。auth'd user 不會打中（autocomplete 已有 1000/24h）。
  POI_SEARCH_PER_IP: { maxAttempts: 200, windowMs: 24 * 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // v2.39.0: public share view GET /api/share/:token — anonymous, paid-quota +
  // write-amplification (view_count) DoS guard. 200/24h/IP：正常 recipient 完全
  // 打不中（不同 IP），但擋掉 single-IP 掃 token / 灌瀏覽數。
  SHARE_VIEW_PER_IP: { maxAttempts: 200, windowMs: 24 * 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // v2.40.0: clone-share per authenticated user — each clone runs hundreds of D1
  // subrequests (findOrCreatePoi loop + chunked inserts); cap repetition on top of the
  // absolute MAX_TRIPS_PER_USER. 10/hr is generous for humans, blocks loop abuse.
  CLONE_PER_USER: { maxAttempts: 10, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
  // v2.42.0: clone per-IP pre-gate (defence-in-depth on top of per-user) — blocks a
  // single IP cycling throwaway accounts to amplify clone subrequests. 30/hr/IP.
  CLONE_PER_IP: { maxAttempts: 30, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 },
} as const;
