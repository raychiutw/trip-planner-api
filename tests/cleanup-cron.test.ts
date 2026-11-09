/**
 * 清理排程（trip-planner#1627 階段 1）：把 web repo 三支 GitHub Actions 的 SQL 等價搬進 Cron Trigger。
 * 真 SQLite。守衛：只刪該刪的（cutoff／locked／30 天／孤兒 cloned）、重跑 0 效果、各支獨立、
 * log 只含表名與筆數、cron 表達式對應正確的清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runCleanup, CRON_RATE_LIMIT, CRON_SHARES, CRON_INVITATIONS } from '../src/lib/cleanup-cron';
import worker from '../src/index';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
const mkEnv = () => ({ DB: d1.db }) as Env;
const count = (t: string) => (d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const ids = (sql: string) => (d1.raw.prepare(sql).all() as { k: string }[]).map((r) => r.k).sort();
const nowMs = () => Date.now();
const H = 3600_000;
const D = 86_400_000;

beforeEach(() => {
  d1 = createD1();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'secret@example.com')").run();
  d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id) VALUES ('t1', 'T', 'u1')").run();
});
afterEach(() => { d1.close(); vi.restoreAllMocks(); });

describe('rate_limit_buckets（每小時）', () => {
  const bucket = (k: string, windowStart: number, lockedUntil: number | null) =>
    d1.raw.prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, 1, ?, ?)').run(k, windowStart, lockedUntil);

  it('只刪 unlocked 且 window_start 超過 1 小時的；鎖中（含已過鎖期但 locked_until 非 NULL）一律保留', async () => {
    bucket('old-unlocked', nowMs() - 2 * H, null);
    bucket('fresh-unlocked', nowMs() - 10 * 60_000, null);
    bucket('old-locked-active', nowMs() - 2 * H, nowMs() + H);
    bucket('old-locked-expired', nowMs() - 2 * H, nowMs() - H);
    await runCleanup(mkEnv(), CRON_RATE_LIMIT);
    expect(ids('SELECT bucket_key AS k FROM rate_limit_buckets')).toEqual(['fresh-unlocked', 'old-locked-active', 'old-locked-expired']);
    await runCleanup(mkEnv(), CRON_RATE_LIMIT); // 重跑 0 效果
    expect(count('rate_limit_buckets')).toBe(3);
  });

  it('剛好 1 小時邊界不刪（嚴格小於）', async () => {
    bucket('edge', nowMs() - H + 5_000, null);
    await runCleanup(mkEnv(), CRON_RATE_LIMIT);
    expect(count('rate_limit_buckets')).toBe(1);
  });
});

describe('trip_shares + 孤兒 cloned trips（每日）', () => {
  const share = (h: string, exp: number | null) =>
    d1.raw.prepare("INSERT INTO trip_shares (trip_id, token_hash, expires_at) VALUES ('t1', ?, ?)").run(h, exp);
  const trip = (id: string, src: string, age: string) =>
    d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id, data_source, created_at) VALUES (?, 'C', 'u1', ?, datetime('now', ?))").run(id, src, age);

  it('分享連結：只刪過期超過 30 天；永久（NULL）與寬限內保留', async () => {
    share('expired-31d', nowMs() - 31 * D);
    share('expired-29d', nowMs() - 29 * D);
    share('never', null);
    share('future', nowMs() + D);
    await runCleanup(mkEnv(), CRON_SHARES);
    expect(ids('SELECT token_hash AS k FROM trip_shares')).toEqual(['expired-29d', 'future', 'never']);
    await runCleanup(mkEnv(), CRON_SHARES);
    expect(count('trip_shares')).toBe(3);
  });

  it('孤兒 cloned：只刪 cloned、超過 1 天、且無任何 permission；子資料連動（CASCADE）', async () => {
    trip('orphan-old', 'cloned', '-2 days');
    trip('orphan-new', 'cloned', '-1 hours');
    trip('owned-old', 'cloned', '-2 days');
    trip('manual-old', 'manual', '-2 days');
    d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('u1', 'owned-old', 'owner')").run();
    d1.raw.prepare("INSERT INTO trip_shares (trip_id, token_hash) VALUES ('orphan-old', 'child')").run();
    await runCleanup(mkEnv(), CRON_SHARES);
    expect(ids("SELECT id AS k FROM trips WHERE id != 't1'")).toEqual(['manual-old', 'orphan-new', 'owned-old']);
    expect(ids("SELECT token_hash AS k FROM trip_shares WHERE token_hash = 'child'")).toEqual([]);
  });

  it('trip_permissions 為空時不會誤刪所有 cloned 之外的 trip（t1 為 manual 保留）', async () => {
    await runCleanup(mkEnv(), CRON_SHARES);
    expect(count('trips')).toBe(1);
  });
});

describe('trip_invitations（每日，30 天）', () => {
  const inv = (h: string, expires: string, accepted: string | null) =>
    d1.raw.prepare("INSERT INTO trip_invitations (token_hash, trip_id, invited_email, expires_at, accepted_at) VALUES (?, 't1', ?, ?, ?)")
      .run(h, `${h}@example.com`, expires, accepted);
  const ago = (days: number) => new Date(nowMs() - days * D).toISOString();
  const agoSql = (days: number) => d1.raw.prepare("SELECT datetime('now', ?) AS d").get(`-${days} days`) as { d: string };

  it('刪：accepted 超過 30 天、未接受且過期超過 30 天；留：30 天內、pending（未過期）', async () => {
    inv('acc-32d', agoSql(40).d, ago(32));
    inv('acc-28d', agoSql(40).d, ago(28));
    inv('unacc-exp-32d', agoSql(32).d, null);
    inv('unacc-exp-28d', agoSql(28).d, null);
    inv('pending', new Date(nowMs() + D).toISOString(), null);
    await runCleanup(mkEnv(), CRON_INVITATIONS);
    expect(ids('SELECT token_hash AS k FROM trip_invitations')).toEqual(['acc-29d', 'pending', 'unacc-exp-28d']);
    await runCleanup(mkEnv(), CRON_INVITATIONS);
    expect(count('trip_invitations')).toBe(3);
  });
});

describe('排程分派與隔離', () => {
  it('每支 cron 只跑自己的清理（其他表不動）', async () => {
    d1.raw.prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start) VALUES (?, 1, ?)').run('old', nowMs() - 2 * H);
    d1.raw.prepare("INSERT INTO trip_shares (trip_id, token_hash, expires_at) VALUES ('t1', 'old', ?)").run(nowMs() - 40 * D);
    await runCleanup(mkEnv(), CRON_INVITATIONS);
    expect(count('rate_limit_buckets')).toBe(1);
    expect(count('trip_shares')).toBe(1);
    await runCleanup(mkEnv(), '*/10 * * * *'); // 心跳 cron 不觸發任何清理
    expect(count('rate_limit_buckets')).toBe(1);
  });

  it('同一個 cron 內某支失敗（shares 表不存在）不拖垮孤兒 trips 清理，只 console.error', async () => {
    d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id, data_source, created_at) VALUES ('o', 'C', 'u1', 'cloned', datetime('now', '-2 days'))").run();
    d1.raw.exec('DROP TABLE trip_shares');
    await expect(runCleanup(mkEnv(), CRON_SHARES)).resolves.toBeUndefined();
    expect(ids("SELECT id AS k FROM trips WHERE id = 'o'")).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it('log 只含表名與筆數，不含使用者資料', async () => {
    d1.raw.prepare("INSERT INTO trip_invitations (token_hash, trip_id, invited_email, expires_at) VALUES ('tokhash', 't1', 'victim@example.com', datetime('now', '-60 days'))").run();
    await runCleanup(mkEnv(), CRON_INVITATIONS);
    const out = JSON.stringify((console.log as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(out).toContain('trip_invitations');
    expect(out).toContain('1');
    expect(out).not.toMatch(/victim|tokhash|secret@/);
  });

  it('worker.scheduled 依 event.cron 分派並 waitUntil', async () => {
    d1.raw.prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start) VALUES (?, 1, ?)').run('old', nowMs() - 2 * H);
    const ps: Promise<unknown>[] = [];
    worker.scheduled({ cron: CRON_RATE_LIMIT } as ScheduledController, mkEnv(), { waitUntil: (p: Promise<unknown>) => ps.push(p) } as unknown as ExecutionContext);
    await Promise.all(ps);
    expect(count('rate_limit_buckets')).toBe(0);
  });
});
