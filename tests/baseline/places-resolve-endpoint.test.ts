/**
 * GET /api/places/resolve?placeId=... — v2.31.94 custom-stop-location-picker
 *
 * Lightweight wrapper of getPlaceDetails returning coord + display fields.
 * Used by typeahead pick → map flyTo flow (one Place Details call closes the
 * autocomplete session per Google billing semantics).
 *
 * 走 HTTP 邊界（tests/api/http.ts）：真實 middleware、真實 AccessToken、真實 D1
 * （rate_limit_buckets）。Google 是外部邊界，用 google-stub 攔截 global fetch。
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
const user = 't5a-resolve@example.test';
const bucket = `places-resolve:user-${userIdFor(user)}`;

const placeJson = (over: Record<string, unknown> = {}) => ({
  id: 'ChIJ_a',
  displayName: { text: '高雄市左營區' },
  formattedAddress: '高雄市左營區',
  location: { latitude: 22.6724, longitude: 120.2932 },
  businessStatus: 'OPERATIONAL',
  ...over,
});
const simplePlace = () =>
  placeJson({ displayName: { text: 'A' }, formattedAddress: 'A', location: { latitude: 1, longitude: 2 } });

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: API_KEY });
  api = createApi({ env });
});

afterAll(async () => {
  google.restore();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucket).run();
  await db.prepare("DELETE FROM app_settings WHERE key IN ('google_maps_locked', 'google_maps_locked_reason')").run();
  await db.prepare('DELETE FROM users WHERE email = ?').bind(user).run();
  invalidateLockCache();
  await disposeMiniflare();
});

beforeEach(async () => {
  google.reset();
  invalidateLockCache();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucket).run();
});

const get = (qs: string, client: Api = api) => client.get(`/api/places/resolve${qs}`, { as: user });
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const bucketRow = () =>
  db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucket).first<{ count: number }>();
const seedBucket = (count: number, windowStart: number, lockedUntil: number | null) =>
  db.prepare('INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
    .bind(bucket, count, windowStart, lockedUntil).run();

describe('GET /api/places/resolve', () => {
  it('happy path → 200 + coord + name + address', async () => {
    google.respond(() => jsonOk(placeJson()));
    const res = await get('?placeId=ChIJ_a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      placeId: 'ChIJ_a',
      lat: 22.6724,
      lng: 120.2932,
      name: '高雄市左營區',
      address: '高雄市左營區',
    });
  });

  it('forwards sessionToken when supplied (closes Google session)', async () => {
    google.respond(() => jsonOk(simplePlace()));
    await get('?placeId=ChIJ_a&sessionToken=sess-1');
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    const url = new URL(call.url);
    expect(url.pathname).toBe('/v1/places/ChIJ_a');
    expect(url.searchParams.get('sessionToken')).toBe('sess-1');
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
  });

  it('omits sessionToken when not supplied', async () => {
    google.respond(() => jsonOk(simplePlace()));
    await get('?placeId=ChIJ_a');
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(new URL(call.url).pathname).toBe('/v1/places/ChIJ_a');
    expect(new URL(call.url).searchParams.has('sessionToken')).toBe(false);
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
  });

  it('missing placeId → 400 DATA_VALIDATION', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('Place Details returns null → 404 DATA_NOT_FOUND', async () => {
    google.respond(() => jsonOk({}, 404));
    const res = await get('?placeId=ChIJ_missing');
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('DATA_NOT_FOUND');
  });

  it('API key missing → MAPS_UPSTREAM_FAILED', async () => {
    const noKey = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: '' }) });
    const res = await get('?placeId=ChIJ_a', noKey);
    expect(res.status).toBe(502);
    expect(await errCode(res)).toBe('MAPS_UPSTREAM_FAILED');
    expect(google.calls).toHaveLength(0);
  });

  it('bumps per-user rate limit for resolve quota cap', async () => {
    google.respond(() => jsonOk(placeJson()));
    // 原本斷言 bumpRateLimit 的 key 與 maxAttempts=500，改讀真實 D1：
    // bucket key 為 places-resolve:user-<userId>；count 到 500 仍放行、第 501 次才鎖。
    await get('?placeId=ChIJ_a');
    expect((await bucketRow())?.count).toBe(1);

    await seedBucket(499, Date.now(), null);
    expect((await get('?placeId=ChIJ_a')).status).toBe(200);
    expect((await bucketRow())?.count).toBe(500);
    expect((await get('?placeId=ChIJ_a')).status).toBe(429);
    expect((await bucketRow())?.count).toBe(501);
  });

  it('returns 429 RATE_LIMITED when resolve quota exceeded', async () => {
    await seedBucket(10, Date.now(), Date.now() + 3600 * 1000);
    const res = await get('?placeId=ChIJ_a');
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(3500);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(await errCode(res)).toBe('RATE_LIMITED');
    expect(google.calls).toHaveLength(0);
  });

  it('rejects placeId > 256 chars', async () => {
    const res = await get(`?placeId=${'a'.repeat(257)}`);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  it('rejects sessionToken > 128 chars', async () => {
    const res = await get(`?placeId=ChIJ_a&sessionToken=${'b'.repeat(129)}`);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(google.calls).toHaveLength(0);
  });

  // HTTP 邊界新增：原本 assertGoogleAvailable 被 mock 掉，從沒驗過 kill switch
  it('kill switch 啟用 → 503 MAPS_LOCKED，且不打 Google', async () => {
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
    invalidateLockCache();
    try {
      const res = await get('?placeId=ChIJ_a');
      expect(res.status).toBe(503);
      expect(await errCode(res)).toBe('MAPS_LOCKED');
      expect(google.calls).toHaveLength(0);
    } finally {
      await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
      invalidateLockCache();
    }
  });

  // HTTP 邊界新增：原本 requireAuth 被 mock 掉，從沒驗過授權
  it('未認證 → 401，且不打 Google', async () => {
    const res = await api.get('/api/places/resolve?placeId=ChIJ_a');
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });
});
