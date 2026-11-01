/**
 * GET /api/trips — 匿名不得拿到擁有者個資（email + 顯示真名）。
 *
 * 2026-07-16 實測 prod：`curl https://trip-planner-dby.pages.dev/api/trips` 零認證，
 * 回傳 6 個 published 行程，每個都帶 `owner: "<真實 email>"`，其中一個是第三方的。
 * 這支無 auth 時走 `WHERE t.published = 1`（公開行程本來就該看得到），但 baseCols
 * 無條件 SELECT `u.email AS owner` + `u.display_name AS owner_display_name`。
 *
 * owner_display_name 一樣是個資：登入時預設帶 Google 真名（callback/google.ts），
 * 對齊 _share.ts:154「匿名連結 never expose the owner's name」。restrictTrip 降權
 * token 只該碰單一 trip，也不該撈全站 owner 清單。
 *
 * 走 HTTP 邊界（tests/api/http.ts）真的打 API，不是 source-grep —— 重點是「回應裡到底有沒有那些欄／那些值」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

// 刻意選一個「非 email 衍生」的顯示名稱：seedTrip 預設把 display_name 設成 email
// 的 @ 前段（"pub-owner"），那沒法證明真名有沒有外洩。改成一個 email 裡不會出現、
// email-regex 也抓不到的字串，才驗得出 owner_display_name 這條洩漏。
const OWNER_EMAIL = 'pub-owner@example.com';
const TRIP = 'owner-anon-pub-trip';
const OWNER_REAL_NAME = '殷佩妮_真名不該外洩';

describe('GET /api/trips — 擁有者個資不外洩給匿名／受限 token', () => {
  let db: D1Database;
  let api: Api;

  beforeAll(async () => {
    db = await createTestDb();
    api = createApi({ env: mockEnv(db) });
    const { ownerUserId } = await seedTrip(db, { id: TRIP, owner: OWNER_EMAIL, published: 1 });
    // seedTrip 只會把 display_name 設成 email 前段；覆寫成一個真名形狀的值。
    await db.prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(OWNER_REAL_NAME, ownerUserId).run();
  }, 30000);

  afterAll(async () => {
    await cleanupTrips(db, [TRIP]);
    await disposeMiniflare();
  });

  const call = async (auth: { as: string; restrictTrip?: string } | null) => {
    const resp = await api.get('/api/trips', auth ?? {});
    expect(resp.status).toBe(200);
    return (await resp.json()) as Array<Record<string, unknown>>;
  };

  it('匿名 → 回得到 published 行程，但沒有 owner 欄（email）', async () => {
    const rows = await call(null);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain('owner');
    }
  });

  it('匿名 → 沒有 ownerDisplayName 欄（顯示真名同樣是個資）', async () => {
    const rows = await call(null);
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain('ownerDisplayName');
    }
  });

  it('匿名 → 整包 JSON 既無 email 形狀字串，也無 owner 的顯示真名', async () => {
    // 比對 key 名稱擋不住「換個欄名繼續送個資」；email-regex 又抓不到中文真名。
    // 兩條一起掃：任何形狀的 owner 個資都不准出現在匿名回應裡。
    const blob = JSON.stringify(await call(null));
    expect(blob).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
    expect(blob).not.toContain(OWNER_REAL_NAME);
  });

  it('任何登入者 → 一樣拿不到 owner／ownerDisplayName', async () => {
    // 2026-07-21 翻轉。原本這條斷言「登入者拿得到」，理由寫「前端比對『我的行程』
    // ＋avatar 要用」—— 那個理由不成立：前端行程清單讀的是 `/api/my-trips`
    // （TripsListPage.tsx:832），不是這支。`GET /api/trips` 的 owner 欄位沒有任何
    // 前端 consumer。
    //
    // 而門檻只設到「有登入」的後果，是實測拿得到的：用當天新註冊的 demo 帳號打 prod，
    // 撈到與該帳號毫無關係的第三方 email。註冊是任何人都能做的事，等於零門檻。
    //
    // 需要 owner 的情境（自己的行程卡片、avatar）由 `/api/my-trips` 供應，那支以
    // trip_permissions 為條件，給的是「你有權限的行程」的 owner，合理且已足夠。
    const rows = await call({ as: 'owner-anon-viewer@test.com' });
    expect(rows.length, '登入者仍應看得到公開行程清單本身').toBeGreaterThan(0);

    const blob = JSON.stringify(rows);
    expect(blob, '登入者不該撈到全站公開行程擁有者的 email').not.toMatch(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
    expect(blob, '顯示真名同樣是個資').not.toContain(OWNER_REAL_NAME);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('owner');
      expect(Object.keys(row)).not.toContain('ownerDisplayName');
    }
  });

  it('restrict_trip 降權 token → 拿不到 owner／ownerDisplayName（只該碰被授權的單一 trip）', async () => {
    // isServiceToken=false + userId 有值，但 restrictTrip 綁死一個 trip。這種 token
    // 若能撈全站 published owner email，就繞過了它自己的 scope。
    const rows = await call({ as: 'owner-anon-agent@test.com', restrictTrip: 'some-other-trip' });
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/);
    expect(blob).not.toContain(OWNER_REAL_NAME);
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain('owner');
    }
  });
});
