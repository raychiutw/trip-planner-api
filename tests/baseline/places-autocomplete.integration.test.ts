/**
 * Integration test — POST /api/places/autocomplete
 *
 * v2.33.104 T-8: 涵蓋 validation + 429 rate-limit + GOOGLE_MAPS_API_KEY 缺失。
 *
 * 走 HTTP 邊界（tests/api/http.ts），認證用真實 bearer token。Google 是外部邊界：
 * 用 tests/api/google-stub.ts 攔截 global fetch，並明確斷言送給 Places autocomplete 的
 * method、URL、金鑰 header、field mask 與 body。
 * 共用 D1：專屬 email（rate-limit bucket 以 user id 為 key），結束時清掉。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { stubGoogle, jsonOk } from './google-stub';
import { serviceToken } from './service-token';
import { invalidateLockCache } from '../../src/lib/maps-lock';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const google = stubGoogle();

const API_KEY = 'test-key';
const user = 's10-autocomplete@example.test';
const rateUser = 's10-autocomplete-rate@example.test';
const bucketOf = (email: string) => `places-autocomplete:user-${userIdFor(email)}`;

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { GOOGLE_MAPS_API_KEY: API_KEY, ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
});

afterAll(async () => {
  google.restore();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key IN (?, ?)').bind(bucketOf(user), bucketOf(rateUser)).run();
  await db.prepare("DELETE FROM app_settings WHERE key IN ('google_maps_locked', 'google_maps_locked_reason')").run();
  invalidateLockCache();
  await db.prepare('DELETE FROM users WHERE email IN (?, ?)').bind(user, rateUser).run();
  await disposeMiniflare();
});

beforeEach(async () => {
  google.reset();
  // 重置 rate-limit bucket 避免 test 互相影響
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(bucketOf(user)).run();
});

const post = (body: unknown, as: string | null = user, client: Api = api) =>
  client.request('POST', '/api/places/autocomplete', as ? { as, json: body } : { json: body, headers: { Origin: 'https://trip-planner-dby.pages.dev' } });

describe('POST /api/places/autocomplete (T-8)', () => {
  it('未認證（瀏覽器同源請求，無 session）→ 401', async () => {
    const res = await post({ q: 'taipei', sessionToken: 'sess-1' }, null);
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it('q < 2 字元 → 400', async () => {
    const res = await post({ q: 'a', sessionToken: 'sess-1' });
    expect(res.status).toBe(400);
    expect(google.calls).toHaveLength(0);
  });

  it('q > 200 字元 → 400', async () => {
    const res = await post({ q: 'a'.repeat(201), sessionToken: 'sess-1' });
    expect(res.status).toBe(400);
  });

  it('missing sessionToken → 400', async () => {
    const res = await post({ q: 'taipei' });
    expect(res.status).toBe(400);
  });

  it('sessionToken > 128 字元 → 400', async () => {
    const res = await post({ q: 'taipei', sessionToken: 'x'.repeat(129) });
    expect(res.status).toBe(400);
  });

  it('regionCode > 8 字元 → 400', async () => {
    const res = await post({ q: 'taipei', sessionToken: 'sess-1', regionCode: 'TWWWWWWWW' });
    expect(res.status).toBe(400);
  });

  it('GOOGLE_MAPS_API_KEY 缺失 → 502，且不打 Google', async () => {
    const noKey = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: '' }) });
    const res = await post({ q: 'taipei', sessionToken: 'sess-1' }, user, noKey);
    expect(res.status).toBe(502);
    expect(google.calls).toHaveLength(0);
  });

  it('service token（沒有 user id）→ 401，且不打 Google', async () => {
    const token = await serviceToken(db, ['companion']);
    const res = await api.request('POST', '/api/places/autocomplete', {
      bearer: token,
      json: { q: 'taipei', sessionToken: 'sess-1' },
    });
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it('kill switch 啟用 → 503 MAPS_LOCKED，且不打 Google', async () => {
    await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('google_maps_locked', 'true')").run();
    invalidateLockCache();
    try {
      const res = await post({ q: 'taipei', sessionToken: 'sess-1' });
      expect(res.status).toBe(503);
      expect(google.calls).toHaveLength(0);
    } finally {
      await db.prepare("DELETE FROM app_settings WHERE key = 'google_maps_locked'").run();
      invalidateLockCache();
    }
  });

  it('happy path → 200 + predictions，並送出正確的 Places autocomplete 請求', async () => {
    google.respond(() => jsonOk({
      suggestions: [
        { placePrediction: { placeId: 'ChIJ_test', structuredFormat: { mainText: { text: 'Test Place' }, secondaryText: { text: 'City' } } } },
        { queryPrediction: { text: { text: '不是地點建議' } } },
      ],
    }));
    const res = await post({ q: 'taipei', sessionToken: 'sess-1', regionCode: 'TW' });
    expect(res.status).toBe(200);
    const data = await res.json() as { predictions: Array<Record<string, unknown>> };
    expect(data.predictions).toEqual([{ placeId: 'ChIJ_test', primaryText: 'Test Place', secondaryText: 'City' }]);

    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(call.url).not.toContain(API_KEY);
    expect(call.headers.get('X-Goog-Api-Key')).toBe(API_KEY);
    expect(call.headers.get('X-Goog-FieldMask')).toBe(
      'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    );
    // sessionToken 原樣帶給 Google（計費 session 靠它）；regionCode 轉小寫
    expect(call.body).toEqual({ input: 'taipei', sessionToken: 'sess-1', languageCode: 'zh-TW', includedRegionCodes: ['tw'] });
    expect(JSON.stringify(data)).not.toContain(API_KEY);
  });

  it('Google 回 503 → 502 MAPS_UPSTREAM_FAILED', async () => {
    google.respond(() => jsonOk({ suggestions: [] }, 503));
    const res = await post({ q: 'taipei', sessionToken: 'sess-1' });
    expect(res.status).toBe(502);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('MAPS_UPSTREAM_FAILED');
  });

  it('每次成功呼叫都計入該使用者的 rate-limit bucket', async () => {
    google.respond(() => jsonOk({ suggestions: [] }));
    await post({ q: 'taipei', sessionToken: 'sess-1' });
    await post({ q: 'taipei', sessionToken: 'sess-1' });
    const bucket = await db.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?')
      .bind(bucketOf(user)).first<{ count: number }>();
    expect(bucket?.count).toBe(2);
  });

  it('rate-limit 達 1000 → 429 + Retry-After header，且不打 Google', async () => {
    // 直接污染 D1 bucket 到 lockout 狀態
    await db.prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until`,
    ).bind(bucketOf(rateUser), 1001, Date.now(), Date.now() + 3600 * 1000).run();

    const resp = await post({ q: 'taipei', sessionToken: 'sess-1' }, rateUser);
    expect(resp.status).toBe(429);
    expect(resp.headers.get('Retry-After')).toBeTruthy();
    const data = await resp.json() as { error?: { code?: string } };
    expect(data.error?.code).toBe('RATE_LIMITED');
    expect(google.calls).toHaveLength(0);
  });
});
