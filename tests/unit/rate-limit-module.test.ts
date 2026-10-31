/**
 * functions/api/_rate_limit.ts integration test
 *
 * V2-P6 brute-force defence + poi-favorites-rename §3.5：
 * bumpRateLimit 改 atomic INSERT...ON CONFLICT 後，mock 無法 simulate ON CONFLICT
 * 語意，故全 DB-touching 測試走 real D1（Miniflare）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  checkRateLimit,
  bumpRateLimit,
  resetRateLimit,
  clientIp,
  RATE_LIMITS,
} from '../../src/lib/rate-limit';
import { createTestDb, disposeMiniflare } from './_d1-setup';

let db: D1Database;

const TEST_KEY = 'login-test:1.2.3.4';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(disposeMiniflare);

beforeEach(async () => {
  await db
    .prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'login-test:%'")
    .run();
});

async function seedBucket(opts: {
  count: number;
  windowStartOffsetMs: number;
  lockedUntil: number | null;
}): Promise<void> {
  await db
    .prepare(
      'INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)',
    )
    .bind(TEST_KEY, opts.count, Date.now() + opts.windowStartOffsetMs, opts.lockedUntil)
    .run();
}

describe('checkRateLimit', () => {
  it('returns ok=true when no row exists (new bucket)', async () => {
    const result = await checkRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });

  it('returns ok=false + retryAfter when locked', async () => {
    const futureLock = Date.now() + 15 * 60 * 1000;
    await db
      .prepare(
        'INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)',
      )
      .bind(TEST_KEY, 5, Date.now() - 1000, futureLock)
      .run();

    const result = await checkRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(800);
    expect(result.retryAfter).toBeLessThanOrEqual(900);
  });

  it('returns ok=true when window expired (count resets)', async () => {
    await seedBucket({
      count: 4,
      windowStartOffsetMs: -(RATE_LIMITS.LOGIN.windowMs + 1000),
      lockedUntil: null,
    });

    const result = await checkRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });

  it('returns ok=true with current count when within window + not locked', async () => {
    await seedBucket({ count: 3, windowStartOffsetMs: -1000, lockedUntil: null });

    const result = await checkRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
  });
});

describe('bumpRateLimit (atomic INSERT ON CONFLICT)', () => {
  it('first attempt → count=1, no lock', async () => {
    const result = await bumpRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });

  it('5 attempts within window → count=5, no lock yet (≤ maxAttempts)', async () => {
    await seedBucket({ count: 4, windowStartOffsetMs: -1000, lockedUntil: null });

    const result = await bumpRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(5);
  });

  it('6th attempt → count=6, locked', async () => {
    await seedBucket({ count: 5, windowStartOffsetMs: -1000, lockedUntil: null });

    const result = await bumpRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.count).toBe(6);
  });

  it('attempt after window expiry → reset count + window', async () => {
    await seedBucket({
      count: 5,
      windowStartOffsetMs: -(RATE_LIMITS.LOGIN.windowMs + 1000),
      lockedUntil: null,
    });

    const result = await bumpRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });

  it('attempt after window expiry on previously locked bucket → lock cleared (new window)', async () => {
    // Window 過期 + 之前已 lock — 新窗口應重置 count=1 且清 lock
    await seedBucket({
      count: 50,
      windowStartOffsetMs: -(RATE_LIMITS.LOGIN.windowMs + 1000),
      lockedUntil: Date.now() - 100, // 已過期 lock
    });

    const result = await bumpRateLimit(db, TEST_KEY, RATE_LIMITS.LOGIN);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);

    const row = await db
      .prepare('SELECT locked_until FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(TEST_KEY)
      .first<{ locked_until: number | null }>();
    expect(row!.locked_until).toBeNull();
  });
});

describe('resetRateLimit', () => {
  it('DELETE the bucket row', async () => {
    await seedBucket({ count: 3, windowStartOffsetMs: -1000, lockedUntil: null });

    await resetRateLimit(db, TEST_KEY);

    const row = await db
      .prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(TEST_KEY)
      .first();
    expect(row).toBeNull();
  });
});

describe('clientIp', () => {
  it('reads CF-Connecting-IP header', () => {
    const req = new Request('https://x.com', { headers: { 'CF-Connecting-IP': '203.0.113.5' } });
    expect(clientIp(req)).toBe('203.0.113.5');
  });

  it('returns "unknown" if header missing', () => {
    const req = new Request('https://x.com');
    expect(clientIp(req)).toBe('unknown');
  });
});

describe('RATE_LIMITS presets', () => {
  it('LOGIN: 5 attempts / 15min / 30min lockout', () => {
    expect(RATE_LIMITS.LOGIN.maxAttempts).toBe(5);
    expect(RATE_LIMITS.LOGIN.windowMs).toBe(15 * 60 * 1000);
    expect(RATE_LIMITS.LOGIN.lockoutMs).toBe(30 * 60 * 1000);
  });

  it('SIGNUP: 10 attempts / 1h (bumped from autoplan original 3 — too tight for dev + NAT)', () => {
    expect(RATE_LIMITS.SIGNUP.maxAttempts).toBe(10);
  });

  it('OAUTH_TOKEN: high frequency (100 / min) for active client', () => {
    expect(RATE_LIMITS.OAUTH_TOKEN.maxAttempts).toBe(100);
    expect(RATE_LIMITS.OAUTH_TOKEN.windowMs).toBe(60 * 1000);
  });

  it('SAVED_POIS_WRITE: 10/min, 60s lockout (legacy — soak 中)', () => {
    expect(RATE_LIMITS.SAVED_POIS_WRITE.maxAttempts).toBe(10);
    expect(RATE_LIMITS.SAVED_POIS_WRITE.windowMs).toBe(60 * 1000);
    expect(RATE_LIMITS.SAVED_POIS_WRITE.lockoutMs).toBe(60 * 1000);
  });

  it('POI_FAVORITES_WRITE: 10/min, 60s lockout (新；對齊 SAVED_POIS_WRITE)', () => {
    expect(RATE_LIMITS.POI_FAVORITES_WRITE.maxAttempts).toBe(10);
    expect(RATE_LIMITS.POI_FAVORITES_WRITE.windowMs).toBe(60 * 1000);
    expect(RATE_LIMITS.POI_FAVORITES_WRITE.lockoutMs).toBe(60 * 1000);
  });
});
