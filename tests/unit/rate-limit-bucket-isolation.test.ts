/**
 * Bucket-key isolation test (poi-favorites-rename §3.2)
 *
 * 同一個 user 的 POI favorites 寫入有兩個獨立 bucket：
 *   poi-favorites-post:user:${userId}      — V2 user web 路徑
 *   poi-favorites-post:companion:${reqId}  — companion path（mac mini cron tp-request）
 *
 * Verify：user bucket 滿（lock）後，companion bucket 不受影響（不同 key）。
 * 紅燈來源：RATE_LIMITS.POI_FAVORITES_WRITE 尚未存在 → import undefined →
 * bumpRateLimit(db, key, undefined) 內部讀 .maxAttempts 噴 TypeError。
 *
 * 設計理由（D16）：bucket 隔離避免 companion 攻擊耗光 user web quota。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './_d1-setup';
import { bumpRateLimit, RATE_LIMITS } from '../../src/lib/rate-limit';

let db: D1Database;

const USER_ID = 'test-user-iso-a';
const COMPANION_REQUEST_ID = 4242;
const USER_BUCKET = `poi-favorites-post:user:${USER_ID}`;
const COMPANION_BUCKET = `poi-favorites-post:companion:${COMPANION_REQUEST_ID}`;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(disposeMiniflare);

beforeEach(async () => {
  await db
    .prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'poi-favorites-post:%'")
    .run();
});

describe('rate limit bucket isolation (user vs companion)', () => {
  it('user bucket exhaustion + lock does NOT affect companion bucket', async () => {
    // Fill user bucket up to maxAttempts (10) + 1 extra to trigger lockout
    const config = RATE_LIMITS.POI_FAVORITES_WRITE;
    let lastUserResult: { ok: boolean; count?: number } = { ok: true };
    for (let i = 0; i < config.maxAttempts + 1; i++) {
      lastUserResult = await bumpRateLimit(db, USER_BUCKET, config);
    }
    // 第 11 次應 lock
    expect(lastUserResult.ok).toBe(false);

    const userRow = await db
      .prepare(
        'SELECT count, locked_until FROM rate_limit_buckets WHERE bucket_key = ?',
      )
      .bind(USER_BUCKET)
      .first<{ count: number; locked_until: number | null }>();
    expect(userRow).not.toBeNull();
    expect(userRow!.count).toBe(config.maxAttempts + 1);
    expect(userRow!.locked_until).not.toBeNull();
    expect(userRow!.locked_until!).toBeGreaterThan(Date.now());

    // companion bucket 應完全 fresh — bump 一次回 ok=true / count=1 / 無 lock
    const companionResult = await bumpRateLimit(db, COMPANION_BUCKET, config);
    expect(companionResult.ok).toBe(true);
    expect(companionResult.count).toBe(1);

    const companionRow = await db
      .prepare(
        'SELECT count, locked_until FROM rate_limit_buckets WHERE bucket_key = ?',
      )
      .bind(COMPANION_BUCKET)
      .first<{ count: number; locked_until: number | null }>();
    expect(companionRow).not.toBeNull();
    expect(companionRow!.count).toBe(1);
    expect(companionRow!.locked_until).toBeNull();
  });

  it('companion bucket lock 不會回壓到 user bucket', async () => {
    const config = RATE_LIMITS.POI_FAVORITES_WRITE;
    // 灌滿 companion bucket
    for (let i = 0; i < config.maxAttempts + 1; i++) {
      await bumpRateLimit(db, COMPANION_BUCKET, config);
    }
    // user bucket 一次都沒 bump 過 — 預期完全 fresh
    const userResult = await bumpRateLimit(db, USER_BUCKET, config);
    expect(userResult.ok).toBe(true);
    expect(userResult.count).toBe(1);
  });
});

describe('RATE_LIMITS.POI_FAVORITES_WRITE preset', () => {
  it('exposes maxAttempts=10, windowMs=60_000, lockoutMs=60_000 (對齊既有 SAVED_POIS_WRITE)', () => {
    expect(RATE_LIMITS.POI_FAVORITES_WRITE).toBeDefined();
    expect(RATE_LIMITS.POI_FAVORITES_WRITE.maxAttempts).toBe(10);
    expect(RATE_LIMITS.POI_FAVORITES_WRITE.windowMs).toBe(60 * 1000);
    expect(RATE_LIMITS.POI_FAVORITES_WRITE.lockoutMs).toBe(60 * 1000);
  });
});
