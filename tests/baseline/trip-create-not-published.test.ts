// @vitest-environment node
/**
 * 新建行程預設**不公開**（owner 決策 2026-07-21：「trip published 要改為 0」）
 *
 * 問題：`GET /api/trips` 會列出所有 `published = 1` 的行程，且**未登入可讀**。
 * 後端的預設本來就是 0，但 web 前端建立時寫死 `published: 1`（NewTripPage）、
 * Flutter 的 `createTrip` 也預設 `published = 1` —— 於是每個使用者新建的行程
 * 都立刻對全世界公開，包含行程名稱、日期、國家與成員數。
 *
 * 2026-07-21 實測 prod：用剛註冊的全新帳號打 `/api/trips` 拿到 10 個他人行程；
 * 未登入也拿得到（只是不含 owner email，那條 2026-07-16 已修）。
 *
 * 使用者不會預期「建立行程」等於「發佈行程」。預設改為不公開，要公開得明確選擇。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

// 走 HTTP 邊界（tests/api/http.ts）；共用 D1，結束時清掉自己建立的行程（以專屬 owner 找出）。
const EMAIL = 'pd@example.com';

describe('POST /api/trips — 預設不公開', () => {
  let db: D1Database;
  let api: Api;

  beforeAll(async () => {
    db = await createTestDb();
    api = createApi({ env: mockEnv(db) });
  }, 30000);

  afterAll(async () => {
    const owned = await db.prepare('SELECT t.id FROM trips t JOIN users u ON u.id = t.owner_user_id WHERE u.email = ?')
      .bind(EMAIL).all<{ id: string }>();
    await cleanupTrips(db, owned.results.map((r) => r.id));
    await disposeMiniflare();
  });

  const create = (body: unknown) => api.request('POST', '/api/trips', { as: EMAIL, json: body });

  const base = { name: '東京', startDate: '2026-09-01', endDate: '2026-09-02' };

  it('沒指定 published → 存成 0', async () => {
    const res = await create(base);
    const { tripId } = (await res.json()) as { tripId: string };
    const row = await db.prepare('SELECT published FROM trips WHERE id = ?')
      .bind(tripId).first<{ published: number }>();
    expect(row!.published).toBe(0);
  });

  it('新建的行程不會出現在未登入的公開清單', async () => {
    const res = await create({ ...base, name: '不該外流的行程' });
    const { tripId } = (await res.json()) as { tripId: string };

    const listed = (await (await api.get('/api/trips')).json()) as Array<{ tripId: string }>;
    expect(listed.some((t) => t.tripId === tripId), '新行程外洩到匿名可讀的公開清單').toBe(false);
  });

  it('明確指定 published: 1 仍可公開 —— 改的是預設，不是拿掉功能', async () => {
    const res = await create({ ...base, published: 1 });
    const { tripId } = (await res.json()) as { tripId: string };
    const row = await db.prepare('SELECT published FROM trips WHERE id = ?')
      .bind(tripId).first<{ published: number }>();
    expect(row!.published).toBe(1);
  });
});
