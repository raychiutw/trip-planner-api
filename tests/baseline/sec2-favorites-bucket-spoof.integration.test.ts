/**
 * v2.33.105 SEC-2 regression — poi-favorites bucket-spoof attack prevention.
 *
 * 之前 `pickFavoriteRateLimitBucket` 從 body.companionRequestId (claimed) 直接
 * 組 bucket key，並在 actor resolve 之前 bump。Unauthenticated attacker 可送
 * X-Request-Scope: companion + companionRequestId: 999 → bucket
 * `poi-favorites-post:companion:999` 被 bump 即使後續 actor resolve 401。
 * 10 個 fake request → bucket lock → 之後 legit user 用 requestId=999 → 429。
 *
 * Fix：preGateFavoriteThrottle (per-IP) + pickFavoriteBucketForActor (post-gate)
 * 把 bucket key 綁定到 verified actor。Unauthenticated attempt 不會 bump 任何
 * companion bucket。
 *
 * 走 HTTP 邊界：真實路由派送（middleware → handler），匿名請求補上允許的 Origin
 * （變更類請求沒有 Origin 會先被 CSRF 擋下）；使用者以真實 bearer 呼叫。
 *
 * 注意：純匿名請求在 middleware 就回 401，到不了 handler 的 actor resolve；真正會走到
 * 「companion 解析失敗 → 401」的是帶了 bearer 但沒有 companion scope 的呼叫端（例如被偷走的
 * 一般服務 token），所以 spoof 案例同時用匿名與這種 token 各打一次。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { serviceTokenFor } from './service-token';
import type { Env } from '../../src/env';

const BASE = 'https://test.com';
const ORIGIN = 'https://trip-planner-dby.pages.dev';

let db: D1Database;
let env: Env;
let api: Api;
let validPoiId: number;
const bucketKeys: string[] = [];
const users: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  // 模擬 companion service token client_id 設定
  env.TP_REQUEST_CLIENT_ID = 'tp-request';
  api = createApi({ env });
  validPoiId = await seedPoi(db, { name: 'sec2-test-poi' });
});

afterAll(async () => {
  for (const key of bucketKeys) {
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key = ?').bind(key).run();
  }
  for (const userId of users) {
    await db.prepare('DELETE FROM poi_favorites WHERE user_id = ?').bind(userId).run();
  }
  await db.prepare('DELETE FROM audit_log WHERE request_id IN (999999, 888888)').run();
  await db.prepare("DELETE FROM pois WHERE name = 'sec2-test-poi'").run();
  await disposeMiniflare();
});

function spoofedCompanionPost(ip: string, companionRequestId: number, bearer?: string): Promise<Response> {
  return api.request('POST', `${BASE}/api/poi-favorites`, {
    // 無 auth（匿名）或只有無 companion scope 的 bearer — 模擬 unauthenticated / stolen-credential 場景
    bearer,
    headers: { Origin: ORIGIN, 'X-Request-Scope': 'companion', 'CF-Connecting-IP': ip },
    json: { poiId: validPoiId, companionRequestId },
  });
}

const bucketOf = (key: string) =>
  db.prepare('SELECT count, locked_until FROM rate_limit_buckets WHERE bucket_key = ?').bind(key)
    .first<{ count: number; locked_until: number | null }>();

describe('v2.33.105 SEC-2 bucket-spoof DoS prevention', () => {
  it('unauthenticated header companion + claimed requestId=999 → 401, 不該 bump companion bucket', async () => {
    // 攻擊者送 fake companion header + 隨意 requestId
    const fakeRequestId = 999_999;
    const key = `poi-favorites-post:companion:${fakeRequestId}`;
    bucketKeys.push(key, 'poi-favorites-pre-gate-ip:1.2.3.4');
    const resp = await spoofedCompanionPost('1.2.3.4', fakeRequestId);
    expect(resp.status).toBe(401);
    // 無 companion scope 的 bearer：到得了 handler，pre-gate IP throttle 通過（< 200 limit）→ actor resolve 失敗 → 401
    const stolen = await serviceTokenFor(db, { clientId: 'sec2-rogue', scopes: ['trips:read'] });
    const resp2 = await spoofedCompanionPost('1.2.3.4', fakeRequestId, stolen);
    expect(resp2.status).toBe(401);

    // verify companion bucket 沒被 bump（spoof-proof）
    expect(await bucketOf(key)).toBeNull();
  });

  it('10 個 unauthenticated bucket-spoof attempts → 不會 lock 該 requestId bucket', async () => {
    const targetRequestId = 888_888;
    const key = `poi-favorites-post:companion:${targetRequestId}`;
    bucketKeys.push(key, 'poi-favorites-pre-gate-ip:5.6.7.8');
    // Fire 10 spoofed attempts
    const stolen = await serviceTokenFor(db, { clientId: 'sec2-rogue', scopes: ['trips:read'] });
    for (let i = 0; i < 10; i++) {
      const resp = await spoofedCompanionPost('5.6.7.8', targetRequestId, i % 2 ? stolen : undefined);
      expect(resp.status).toBe(401);
    }
    // companion bucket 應該完全 fresh（spoof 不可 bump 它）
    expect(await bucketOf(key)).toBeNull();
  });

  it('pre-gate IP throttle: 200 burst 同 IP 觸 lock', async () => {
    const ipBucketKey = 'poi-favorites-pre-gate-ip:9.9.9.9';
    bucketKeys.push(ipBucketKey);
    // 直接污染 bucket 到 lockout
    await db.prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, count, window_start, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until`,
    ).bind(ipBucketKey, 201, Date.now(), Date.now() + 300 * 1000).run();

    const resp = await api.request('POST', `${BASE}/api/poi-favorites`, {
      as: 'sec2-user@test.com',
      headers: { 'CF-Connecting-IP': '9.9.9.9' },
      json: { poiId: validPoiId },
    });
    expect(resp.status).toBe(429);
  });

  it('post-gate bucket 用 RESOLVED actor.userId 不是 claimed body', async () => {
    // V2 user POST without companion header → bucket key 應該是 user-based
    const email = 'sec2-user-bucket@test.com';
    const userId = userIdFor(email);
    users.push(userId);
    bucketKeys.push(`poi-favorites-post:user:${userId}`, 'poi-favorites-post:companion:777', 'poi-favorites-pre-gate-ip:10.0.0.1');
    const resp = await api.request('POST', `${BASE}/api/poi-favorites`, {
      as: email,
      headers: { 'CF-Connecting-IP': '10.0.0.1' },
      // 帶 companionRequestId 但無 X-Request-Scope header → 應被忽略
      json: { poiId: validPoiId, companionRequestId: 777 },
    });
    expect(resp.status).toBe(201);

    // bucket 應該是 user-based
    const userBucket = await bucketOf(`poi-favorites-post:user:${userId}`);
    expect(userBucket).not.toBeNull();
    expect(userBucket!.count).toBeGreaterThanOrEqual(1);

    // claimed-but-unused companion bucket 不該存在
    expect(await bucketOf('poi-favorites-post:companion:777')).toBeNull();
  });
});
