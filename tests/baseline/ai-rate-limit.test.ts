/**
 * Integration test — #1597：AI 聊天請求（POST /api/requests）與重算交通
 * （POST /api/trips/:id/recompute-travel）的每帳號頻率限制。
 * 同一組案例在新 api（舊入口 trip-planner tests/api/ai-rate-limit.integration.test.ts）各有一套，行為必須一致。
 * 超限判定：第 max+1 次請求回 429；不管換句話或等過 30 秒去重窗都不能繞過。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../../src/lib/maps/google-client', () => ({
  computeRoute: vi.fn(async () => ({ polyline: 'mock', distance_meters: 1000, duration_seconds: 60 })),
}));
vi.mock('../../src/lib/maps-lock', () => ({
  assertGoogleAvailable: vi.fn(async () => undefined),
}));

import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { computeRoute } from '../../src/lib/maps/google-client';
import { cleanupTrips } from './cleanup-trips';
import type { Env } from '../../src/env';

const TRIP = 's1597-rl-trip';
const OWNER = 's1597-rl-owner@test.com';
const OTHER = 's1597-rl-other@test.com';
const AI_MAX = 30;
const RECOMPUTE_MAX = 30;

let db: D1Database;
let api: Api;

const aiBucket = (email: string) => `ai-request:user:${userIdFor(email)}`;
const recomputeBucket = (email: string) => `recompute-travel:user:${userIdFor(email)}`;
const sendAi = (message: string, as = OWNER) => api.request('POST', '/api/requests', { as, json: { tripId: TRIP, message } });
const recompute = (as = OWNER) => api.request('POST', `/api/trips/${TRIP}/recompute-travel?day=all`, { as });

async function seedBucket(key: string, count: number, windowStartOffsetMs = -1000, lockedUntil: number | null = null) {
  await db.prepare('INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
    .bind(key, count, Date.now() + windowStartOffsetMs, lockedUntil).run();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' } as Partial<Env>) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
  const otherId = userIdFor(OTHER);
  await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(otherId, OTHER, 'other').run();
  await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'member')").bind(otherId, TRIP).run();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'ai-request:%' OR bucket_key LIKE 'recompute-travel:%'").run();
  vi.mocked(computeRoute).mockClear();
});

afterAll(async () => {
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'ai-request:%' OR bucket_key LIKE 'recompute-travel:%'").run();
  await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('POST /api/requests — AI 聊天每帳號限流', () => {
  it('未超過上限 → 201，bucket 計數 +1', async () => {
    await seedBucket(aiBucket(OWNER), AI_MAX - 1);
    const resp = await sendAi('s1597 under limit');
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').bind(aiBucket(OWNER)).first<{ count: number }>();
    expect(row?.count).toBe(AI_MAX);
  });

  it('超過上限 → 429 + Retry-After + SYS_RATE_LIMIT，且不建立請求；換句話也擋', async () => {
    await seedBucket(aiBucket(OWNER), AI_MAX);
    for (const message of ['s1597 over a', 's1597 over b (換句話)']) {
      const resp = await sendAi(message);
      expect(resp.status).toBe(429);
      expect(Number(resp.headers.get('Retry-After'))).toBeGreaterThan(0);
      const body = await resp.json() as { error: { code: string } };
      expect(body.error.code).toBe('SYS_RATE_LIMIT');
      const n = await db.prepare('SELECT COUNT(*) AS c FROM trip_requests WHERE message = ?').bind(message).first<{ c: number }>();
      expect(n?.c).toBe(0);
    }
  });

  it('鎖定中、且同句話的 30 秒去重窗已過 → 仍 429（等 30 秒不能繞過）', async () => {
    await seedBucket(aiBucket(OWNER), AI_MAX + 1, -1000, Date.now() + 60_000);
    await db.prepare("INSERT INTO trip_requests (trip_id, message, submitted_by, created_at) VALUES (?, 's1597 old', ?, datetime('now', '-60 seconds'))").bind(TRIP, OWNER).run();
    const resp = await sendAi('s1597 old');
    expect(resp.status).toBe(429);
  });

  it('視窗過後恢復 → 201', async () => {
    await seedBucket(aiBucket(OWNER), AI_MAX + 1, -2 * 60 * 60 * 1000, Date.now() - 60 * 60 * 1000);
    const resp = await sendAi('s1597 recovered');
    expect(resp.status).toBe(201);
  });

  it('限流以帳號為單位：A 被擋不影響旅伴 B', async () => {
    await seedBucket(aiBucket(OWNER), AI_MAX);
    expect((await sendAi('s1597 blocked')).status).toBe(429);
    expect((await sendAi('s1597 other ok', OTHER)).status).toBe(201);
  });

  it('30 秒內的重複送出命中去重（200），不消耗額度', async () => {
    const first = await sendAi('s1597 dup');
    expect(first.status).toBe(201);
    const count = async () => (await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').bind(aiBucket(OWNER)).first<{ count: number }>())?.count;
    const before = await count();
    expect((await sendAi('s1597 dup')).status).toBe(200);
    expect(await count()).toBe(before);
  });
});

describe('POST /api/trips/:id/recompute-travel — 每帳號限流', () => {
  it('未超過上限 → 200，bucket 計數 +1', async () => {
    await seedBucket(recomputeBucket(OWNER), RECOMPUTE_MAX - 1);
    const resp = await recompute();
    expect(resp.status).toBe(200);
    const row = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').bind(recomputeBucket(OWNER)).first<{ count: number }>();
    expect(row?.count).toBe(RECOMPUTE_MAX);
  });

  it('超過上限 → 429 + Retry-After + SYS_RATE_LIMIT，且不打 Google Routes', async () => {
    await seedBucket(recomputeBucket(OWNER), RECOMPUTE_MAX);
    const resp = await recompute();
    expect(resp.status).toBe(429);
    expect(Number(resp.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('SYS_RATE_LIMIT');
    expect(computeRoute).not.toHaveBeenCalled();
  });

  it('視窗過後恢復 → 200', async () => {
    await seedBucket(recomputeBucket(OWNER), RECOMPUTE_MAX + 1, -2 * 60 * 60 * 1000, Date.now() - 60 * 60 * 1000);
    expect((await recompute()).status).toBe(200);
  });

  it('AI 與重算交通是各自獨立的 bucket', async () => {
    await seedBucket(aiBucket(OWNER), AI_MAX);
    expect((await recompute()).status).toBe(200);
  });
});
