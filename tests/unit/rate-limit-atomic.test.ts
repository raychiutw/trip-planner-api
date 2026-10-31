/**
 * Atomic rate-limit test (poi-favorites-rename §3.1)
 *
 * 100 burst concurrent bumpRateLimit on the same bucket → final count must be
 * exactly 100.
 *
 * 當前 read-then-replace 實作下會 race：所有 100 個 promise 同時 await SELECT
 * 拿到舊值（多半是 null 或同一筆 row），各自算 newCount=N+1，再 INSERT OR
 * REPLACE 互相覆寫，最終 count 遠小於 100。Atomic INSERT...ON CONFLICT(bucket_key)
 * DO UPDATE 則由 SQLite 序列化 bump，count 必為 100。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './_d1-setup';
import { bumpRateLimit } from '../../src/lib/rate-limit';

let db: D1Database;

const ATOMIC_BUCKET = 'rl-atomic-test:user-a';

// maxAttempts 設高確保 100 burst 不會中途 lock，便於檢驗純 increment atomic 性
const HIGH_LIMIT_CONFIG = {
  maxAttempts: 1000,
  windowMs: 60 * 1000,
  lockoutMs: 60 * 1000,
};

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(disposeMiniflare);

beforeEach(async () => {
  await db
    .prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'rl-atomic-test:%'")
    .run();
});

describe('bumpRateLimit atomic INSERT ON CONFLICT', () => {
  it('100 burst concurrent bumps on same bucket → final count is exactly 100', async () => {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(bumpRateLimit(db, ATOMIC_BUCKET, HIGH_LIMIT_CONFIG));
    }
    await Promise.all(promises);

    const row = await db
      .prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(ATOMIC_BUCKET)
      .first<{ count: number }>();

    expect(row).not.toBeNull();
    expect(row!.count).toBe(100);
  });

  it('100 burst returns monotonically distinct counts 1..100 (RETURNING 正確回傳本次 count)', async () => {
    const promises: Promise<{ ok: boolean; count?: number }>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(bumpRateLimit(db, ATOMIC_BUCKET, HIGH_LIMIT_CONFIG));
    }
    const results = await Promise.all(promises);
    const counts = results.map((r) => r.count).filter((c): c is number => typeof c === 'number');

    // 每個 bumpRateLimit 應拿到 1..100 中其中一個獨特值（順序不保證但集合須完整）
    expect(counts).toHaveLength(100);
    expect(new Set(counts).size).toBe(100);
    expect(Math.min(...counts)).toBe(1);
    expect(Math.max(...counts)).toBe(100);
  });
});
