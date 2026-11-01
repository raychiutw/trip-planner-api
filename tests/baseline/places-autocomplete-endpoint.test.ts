/**
 * POST /api/places/autocomplete endpoint — v2.31.94 custom-stop-location-picker
 *
 * Body validation + auth gate + Google maps lock + happy path。
 *
 * 走 HTTP 邊界（tests/api/http.ts）：真實 middleware／AccessToken／D1（rate_limit_buckets、
 * app_settings）。Google 是外部邊界，用 google-stub 攔截 global fetch。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { stubGoogle, jsonOk } from './google-stub';
import { invalidateLockCache } from '../../src/lib/maps-lock';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const google = stubGoogle();

const API_KEY = 'test-key';
const user = 't5a-autocomplete@example.test';
const bucket = `places-autocomplete:user-${userIdFor(user)}`;

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: API_KEY, ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
});

afterAll(async () => {
  google.restore();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucket).run();
  await db.prepare("DELETE FROM app_settings WHERE key IN ('google_maps_locked', 'google_maps_locked_reason')").run();
  invalidateLockCache();
  await db.prepare('DELETE FROM users WHERE email = ?').bind(user).run();
  await disposeMiniflare();
});

beforeEach(async () => {
  google.reset();
  google.respond(() => jsonOk({ suggestions: [] }));
  invalidateLockCache();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucket).run();
});

const post = (body: unknown, client: Api = api) =>
  client.request('POST', '/api/places/autocomplete', { as: user, json: body });
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const bucketRow = () =>
  db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucket).first<{ count: number }>();
const seedBucket = (count: number, windowStart: number, lockedUntil: number | null) =>
  db.prepare('INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
    .bind(bucket, count, windowStart, lockedUntil).run();

describe('POST /api/places/autocomplete', () => {
  it('requires auth (delegates to requireAuth)', async () => {
    // 原本只斷言 requireAuth 被呼叫；改驗真實行為：匿名 401 不打 Google，有 token 則放行
    const anon = await api.request('POST', '/api/places/autocomplete', {
      json: { q: 'tokyo', sessionToken: 'uuid' },
      headers: { Origin: 'https://trip-planner-dby.pages.dev' },
    });
    expect(anon.status).toBe(401);
    expect(google.calls).toHaveLength(0);

    const authed = await post({ q: 'tokyo', sessionToken: 'uuid' });
    expect(authed.status).toBe(200);
    expect(google.calls).toHaveLength(1);
  });

  it('checks google maps lock', async () => {
    // 原本斷言 assertGoogleAvailable 被呼叫；改驗 kill switch 真的擋下（503）且不打 Google
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
    invalidateLockCache();
    try {
      const res = await post({ q: 'tokyo', sessionToken: 'uuid' });
      expect(res.status).toBe(503);
      expect(await errCode(res)).toBe('MAPS_LOCKED');
      expect(google.calls).toHaveLength(0);
    } finally {
      await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
      invalidateLockCache();
    }
    // 解鎖後同一請求放行
    expect((await post({ q: 'tokyo', sessionToken: 'uuid' })).status).toBe(200);
  });

  it('returns 200 + predictions array on happy path', async () => {
    google.respond(() => jsonOk({
      suggestions: [
        { placePrediction: { placeId: 'ChIJ_zuoying', structuredFormat: { mainText: { text: '高雄市左營區' }, secondaryText: { text: 'Kaohsiung, Taiwan' } } } },
      ],
    }));
    const res = await post({ q: '高雄市左營', sessionToken: 'sess-1', regionCode: 'tw' });
    expect(res.status).toBe(200);
    const body = await res.json() as { predictions: unknown[] };
    expect(body.predictions).toHaveLength(1);
    expect(body.predictions[0]).toEqual({
      placeId: 'ChIJ_zuoying',
      primaryText: '高雄市左營區',
      secondaryText: 'Kaohsiung, Taiwan',
    });
  });

  it('forwards sessionToken + regionCode to client', async () => {
    await post({ q: 'shibuya', sessionToken: 'sess-XYZ', regionCode: 'JP' });
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
    expect(call.body).toMatchObject({ input: 'shibuya', sessionToken: 'sess-XYZ', includedRegionCodes: ['jp'] });
  });

  it('omits regionCode when caller did not supply', async () => {
    await post({ q: 'tokyo', sessionToken: 'sess-Y' });
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
    expect(call.body).toMatchObject({ input: 'tokyo', sessionToken: 'sess-Y' });
    expect(call.body).not.toHaveProperty('includedRegionCodes');
  });

  it('rejects q < 2 chars with 400 DATA_VALIDATION', async () => {
    const res = await post({ q: 'a', sessionToken: 'sess' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('rejects missing q', async () => {
    const res = await post({ sessionToken: 'sess' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
  });

  it('rejects q > 200 chars (DoS guard)', async () => {
    const res = await post({ q: 'a'.repeat(201), sessionToken: 'sess' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('rejects missing sessionToken', async () => {
    const res = await post({ q: 'tokyo' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
  });

  it('rejects sessionToken not a string', async () => {
    const res = await post({ q: 'tokyo', sessionToken: 123 });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
  });

  it('rejects when GOOGLE_MAPS_API_KEY missing → MAPS_UPSTREAM_FAILED', async () => {
    const noKey = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: '' }) });
    const res = await post({ q: 'tokyo', sessionToken: 'sess' }, noKey);
    expect(res.status).toBe(502);
    expect(await errCode(res)).toBe('MAPS_UPSTREAM_FAILED');
    expect(google.calls).toHaveLength(0);
  });

  it('trims whitespace from q before length check', async () => {
    const res = await post({ q: '   ', sessionToken: 'sess' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('bumps per-user rate limit bucket on every call', async () => {
    // 原本斷言 bumpRateLimit 的 key／maxAttempts=1000／windowMs=24h，改讀真實 D1：
    // key 為 places-autocomplete:user-<userId>；count 1000 仍放行、第 1001 次鎖；窗口 24h 後歸 1。
    await post({ q: 'tokyo', sessionToken: 'sess' });
    expect((await bucketRow())?.count).toBe(1);

    await seedBucket(999, Date.now(), null);
    expect((await post({ q: 'tokyo', sessionToken: 'sess' })).status).toBe(200);
    expect((await bucketRow())?.count).toBe(1000);
    expect((await post({ q: 'tokyo', sessionToken: 'sess' })).status).toBe(429);

    // 窗口超過 24h → 重新計數（windowMs = 24h）
    await seedBucket(1000, Date.now() - 25 * 60 * 60 * 1000, null);
    expect((await post({ q: 'tokyo', sessionToken: 'sess' })).status).toBe(200);
    expect((await bucketRow())?.count).toBe(1);
    // 窗口內（23h）仍累計
    await seedBucket(5, Date.now() - 23 * 60 * 60 * 1000, null);
    expect((await post({ q: 'tokyo', sessionToken: 'sess' })).status).toBe(200);
    expect((await bucketRow())?.count).toBe(6);
  });

  it('returns 429 with Retry-After when rate limit exceeded', async () => {
    await seedBucket(10, Date.now(), Date.now() + 7200 * 1000);
    const res = await post({ q: 'tokyo', sessionToken: 'sess' });
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(7100);
    expect(retry).toBeLessThanOrEqual(7200);
    expect(await errCode(res)).toBe('RATE_LIMITED');
    // autocompletePlaces NOT called when rate limited
    expect(google.calls).toHaveLength(0);
  });
});
