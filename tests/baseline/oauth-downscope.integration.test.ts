/**
 * POST /api/oauth/downscope 經真實路由與 middleware（v2.55.56）
 *
 * 走 HTTP 邊界（tests/api/http.ts）：抓的是單元／mock 測試結構上抓不到的 bug —
 * /api/oauth/* 被 middleware 全 auth-null 短路，downscope 靠 requireAuth 讀 context.data.auth，
 * 若沒把它從短路排除 → 端點永遠 401、整個 user-token 寫入路徑在 prod 是死的。
 *
 * 同時端對端驗 confused-deputy 強制：受限（restrict_trip）token 換發／讀別的 trip → 擋。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

let db: D1Database;
let api: ReturnType<typeof createApi>;
let ownerUserId: string;

// 套件共用同一個 D1：email、trip id、token 都用本檔專用的
const OWNER_EMAIL = 'downscope-owner@test.com';
const TRIPS = ['ds-trip-a', 'ds-trip-b'];

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  // owner 擁有 trip-A 與 trip-B（模擬 A-Ray：同一 owner 多 trip）
  const a = await seedTrip(db, { id: 'ds-trip-a', owner: OWNER_EMAIL });
  await seedTrip(db, { id: 'ds-trip-b', owner: OWNER_EMAIL });
  ownerUserId = a.ownerUserId;
});

const CLEAN_TOKENS = "DELETE FROM oauth_models WHERE name = 'AccessToken' AND (id LIKE 'ds-%' OR json_extract(payload, '$.user_id') IN (?, 'test-user-outsider'))";

afterAll(async () => {
  await db.prepare(CLEAN_TOKENS).bind(ownerUserId).run();
  for (const id of TRIPS) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run();
    await db.prepare('DELETE FROM trip_days WHERE trip_id = ?').bind(id).run();
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

beforeEach(async () => {
  await db.prepare(CLEAN_TOKENS).bind(ownerUserId).run();
});

async function seedAccessToken(opts: {
  token: string;
  userId: string | null;
  restrictTrip?: string;
}): Promise<void> {
  await new D1Adapter(db, 'AccessToken').upsert(
    opts.token,
    {
      jti: opts.token,
      client_id: 'tripline-tp-request',
      user_id: opts.userId,
      scopes: ['openid', 'profile'],
      grantId: `grant-${opts.token}`,
      ...(opts.restrictTrip ? { restrict_trip: opts.restrictTrip } : {}),
    },
    300,
  );
}

const downscope = (tripId: string, bearer?: string) =>
  api.request('POST', 'https://test.com/api/oauth/downscope', { json: { trip_id: tripId }, ...(bearer ? { bearer } : {}) });

describe('POST /api/oauth/downscope through real middleware', () => {
  it('valid user Bearer → 200 + restrict_trip（證明 middleware 有解析 Bearer，未被 oauth-null 短路吃掉）', async () => {
    const token = 'ds-user-token-ok';
    await seedAccessToken({ token, userId: ownerUserId });

    const res = await downscope('ds-trip-a', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.restrict_trip).toBe('ds-trip-a');
    expect(typeof body.access_token).toBe('string');
    expect(body.token_type).toBe('Bearer');

    // 換發的 token row 確實帶 restrict_trip
    const minted = await new D1Adapter(db, 'AccessToken').find(body.access_token as string);
    expect(minted?.restrict_trip).toBe('ds-trip-a');
    expect(minted?.user_id).toBe(ownerUserId);
  });

  it('無 Bearer → 401 AUTH_REQUIRED（middleware 攔）', async () => {
    const res = await downscope('ds-trip-a');
    expect(res.status).toBe(401);
  });

  it('對無寫權的 trip downscope → 403（server 端 re-verify，不信 caller）', async () => {
    const token = 'ds-user-token-noperm';
    // 另一個 user，對 ds-trip-a 無權（新 api 的 bearer 驗證在使用者不存在時 fail-closed，所以要有使用者資料列）
    await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind('test-user-outsider', 'ds-outsider@test.com', 'outsider').run();
    await seedAccessToken({ token, userId: 'test-user-outsider' });
    const res = await downscope('ds-trip-a', token);
    expect(res.status).toBe(403);
  });

  it('已受限 token 再 downscope → 403（防外洩受限 token 自我提權）', async () => {
    const token = 'ds-already-restricted';
    await seedAccessToken({ token, userId: ownerUserId, restrictTrip: 'ds-trip-a' });
    const res = await downscope('ds-trip-b', token);
    expect(res.status).toBe(403);
  });

  // 以下兩個是 mutation 發現的缺口（拿掉對應的 guard，原測試仍全綠）
  it('已受限 token 對「自己那個 trip」再 downscope 也 403（不能無限續命）', async () => {
    const token = 'ds-restricted-same-trip';
    await seedAccessToken({ token, userId: ownerUserId, restrictTrip: 'ds-trip-a' });
    const res = await downscope('ds-trip-a', token);
    expect(res.status).toBe(403);
    const minted = await db
      .prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'AccessToken' AND id != ? AND json_extract(payload, '$.user_id') = ?")
      .bind(token, ownerUserId).first<{ n: number }>();
    expect(minted?.n).toBe(0);
  });

  it('沒有 user 身份的 token（user_id=null 的 service token）→ 403，不換發', async () => {
    const token = 'ds-service-no-user';
    await seedAccessToken({ token, userId: null });
    const res = await downscope('ds-trip-a', token);
    expect(res.status).toBe(403);
  });
});

// 依賴其他組：GET /api/trips/:id 由 trips-core 組登記，此分支合併前路由不存在（404）。
describe('restrict_trip 跨 trip 強制（end-to-end through middleware）', () => {
  it('restrict_trip=ds-trip-a 的 token 讀 ds-trip-b → 403（confused-deputy：連讀都擋）', async () => {
    const token = 'ds-restricted-to-a';
    await seedAccessToken({ token, userId: ownerUserId, restrictTrip: 'ds-trip-a' });
    const res = await api.get('/api/trips/ds-trip-b', { bearer: token });
    expect(res.status).toBe(403);
  });

  it('restrict_trip=ds-trip-a 的 token 讀 ds-trip-a → 200（自己那個 trip 正常）', async () => {
    const token = 'ds-restricted-to-a-2';
    await seedAccessToken({ token, userId: ownerUserId, restrictTrip: 'ds-trip-a' });
    const res = await api.get('/api/trips/ds-trip-a', { bearer: token });
    expect(res.status).toBe(200);
  });
});
