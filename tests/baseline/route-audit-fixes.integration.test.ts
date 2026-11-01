/**
 * Integration test — GET /api/route 的 rate-limit 強制（v2.44.x audit 高風險修正）。
 *
 * 原本在 tests/unit/audit-high-severity-fixes.test.ts 以 mock _rate_limit /
 * _maps_lock / google-client 直接呼叫 onRequestGet；現在走 HTTP 邊界（tests/api/http.ts），
 * rate-limit bucket 是真實 D1 的列，Google Routes 用 google-stub 攔截 global fetch。
 * 共用 D1：專屬 IP 的 bucket（route:ip:203.0.113.2xx），結束時清掉。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { stubGoogle, jsonOk } from './google-stub';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const google = stubGoogle();

const LOCKED_IP = '203.0.113.201';
const FREE_IP = '203.0.113.202';
const QUERY = 'from=139.7,35.6&to=139.8,35.7';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-api-key' });
  api = createApi({ env });
});

afterAll(async () => {
  google.restore();
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'route:ip:203.0.113.2%'").run();
  await disposeMiniflare();
});

beforeEach(() => {
  google.reset();
  google.respond(() => jsonOk({
    routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U' }, duration: '60s', distanceMeters: 100 }],
  }));
});

describe('rate-limit enforcement (regression: bumpRateLimit result was discarded)', () => {
  it('GET /api/route returns 429 + Retry-After when locked, and never calls Google', async () => {
    // 預先放一個已超過上限（ROUTE_PER_IP.maxAttempts = 100）且鎖定中的 bucket
    await db.prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, locked_until = excluded.locked_until`,
    ).bind(`route:ip:${LOCKED_IP}`, 101, Date.now(), Date.now() + 3600_000).run();

    const res = await api.get(`/api/route?${QUERY}`, { headers: { 'CF-Connecting-IP': LOCKED_IP } });
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(google.calls).toHaveLength(0);
  });

  it('GET /api/route proceeds to Google Routes when not locked', async () => {
    const res = await api.get(`/api/route?${QUERY}`, { headers: { 'CF-Connecting-IP': FREE_IP } });
    expect(res.status).toBe(200);
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    // 請求確實計入該 IP 的 bucket
    const row = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(`route:ip:${FREE_IP}`).first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});
