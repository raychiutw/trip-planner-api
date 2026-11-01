/** 0100：rate_limit_buckets.lock_level（階梯式鎖定要記住「目前是第幾次鎖」）。 */
import { describe, it, expect, afterEach } from 'vitest';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
afterEach(() => d1?.close());

describe('0100 rate_limit_buckets.lock_level', () => {
  it('欄位存在、預設 0、不可為 NULL（舊入口的寫入不指定此欄也能運作）', () => {
    d1 = createD1();
    d1.raw.prepare("INSERT INTO rate_limit_buckets (bucket_key, count, window_start) VALUES ('k', 1, 0)").run();
    expect((d1.raw.prepare("SELECT lock_level FROM rate_limit_buckets WHERE bucket_key = 'k'").get() as { lock_level: number }).lock_level).toBe(0);
    expect(() => d1.raw.prepare("UPDATE rate_limit_buckets SET lock_level = NULL WHERE bucket_key = 'k'").run()).toThrow();
  });
  it('套用前已存在的 bucket 資料保留，lock_level 為 0', () => {
    d1 = createD1({ through: 99 });
    d1.raw.prepare("INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES ('old', 7, 123, 456)").run();
    d1.applyMigrationsAfter(99);
    expect(d1.raw.prepare("SELECT count, window_start, locked_until, lock_level FROM rate_limit_buckets WHERE bucket_key = 'old'").get()).toEqual({ count: 7, window_start: 123, locked_until: 456, lock_level: 0 });
  });
});
