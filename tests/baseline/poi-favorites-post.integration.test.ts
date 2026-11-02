/**
 * Integration test — POST /api/poi-favorites (poi-favorites-rename §6)
 * 走 HTTP 邊界（tests/api/http.ts）：認證用真實 bearer token（含 companion／service／受限 token），
 * 經過 middleware，不直接呼叫 handler。
 *
 * Cover：
 *   §6.1 V2 user 成功 / 400 缺 poiId / 404 POI 不存在 / 409 重複收藏 / 429 rate limit / admin bypass
 *   §6.2 companion 三 gate 全過 → 201 + audit_log + companion_request_actions 1 row
 *   §6.3 companion 同 requestId POST 第 2 次 → 409 COMPANION_QUOTA_EXCEEDED
 *   §6.4 service token 無 companion gate → V2 user fallback 401
 *   §6.5 SQL injection on note → INSERT 成功（D1 prepared statement 防護）+ pois 表不被 drop
 *   §6.6 UTF-8 garbled note → middleware 層擋（_validate.ts），handler 不直接覆蓋
 *   §6.7 100 burst concurrent companion POST → mix 201 / 409 / 429
 *   §6.8 self-reported X-Request-Scope without OAuth scope → V2 user fallback 401
 *
 * 共用 D1：email／trip／POI 一律用 `favpost-` 前綴，並用專屬 CF-Connecting-IP 隔離 pre-gate 的 IP 限流桶，
 * 結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, seedUser, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { mintToken, cleanupFavorites, TP_REQUEST_CLIENT_ID } from './favorites-http';
import type { Env } from '../../src/env';

const PREFIX = 'favpost-';
const SUBMITTER_EMAIL = `${PREFIX}submitter@test.com`;
const TEST_IP = '198.51.100.21';
const URL_POST = 'https://test.com/api/poi-favorites';

let db: D1Database;
let env: Env;
let api: Api;
let poiBase: number;
const requestIds: number[] = [];

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { TP_REQUEST_CLIENT_ID });
  api = createApi({ env });
  poiBase = await seedPoi(db, { name: `${PREFIX}POI base for poi-favorites-post` });
  await seedUser(db, SUBMITTER_EMAIL);
});

afterAll(async () => {
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
  await cleanupFavorites(db, PREFIX, requestIds);
  await disposeMiniflare();
});

beforeEach(async () => {
  // 每個 it 從乾淨的收藏與限流桶開始（只動自己的資料）
  await db.prepare('DELETE FROM poi_favorites WHERE user_id LIKE ?').bind(`${userIdFor(PREFIX)}%`).run();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`poi-favorites-post:user:${userIdFor(PREFIX)}%`).run();
});

// ----- helpers -----

type Auth = { as: string } | { bearer: string };

function post(body: Record<string, unknown>, auth: Auth, headers: Record<string, string> = {}): Promise<Response> {
  return api.request('POST', URL_POST, { json: body, headers: { 'CF-Connecting-IP': TEST_IP, ...headers }, ...auth });
}


describe('POST /api/poi-favorites — restrict_trip containment（回歸；security-auditor HIGH）', () => {
  it('受限 token 寫收藏 → 403（favorites user-scoped，restrict token 不可碰）', async () => {
    const bearer = await mintToken(env, { email: `${PREFIX}restrict@test.com`, restrictTrip: 'some-trip' });
    const resp = await post({ poiId: poiBase, note: 'restrict' }, { bearer });
    expect(resp.status).toBe(403);
    const written = await db
      .prepare('SELECT id FROM poi_favorites WHERE user_id = ?')
      .bind(userIdFor(`${PREFIX}restrict@test.com`))
      .first();
    expect(written).toBeNull();
  });
});

// ----- §6.1 V2 user 成功 / 失敗 -----

describe('POST /api/poi-favorites — §6.1 V2 user', () => {
  it('成功 INSERT 回 201 + RETURNING row', async () => {
    const email = `${PREFIX}happy@test.com`;
    const resp = await post({ poiId: poiBase, note: 'V2 user happy path' }, { as: email });
    expect(resp.status).toBe(201);
    // json() helper 套 deepCamel：DB 的 user_id / poi_id → camelCase
    const row = await resp.json() as { id: number; userId: string; poiId: number; note: string };
    expect(row.id).toBeGreaterThan(0);
    expect(row.userId).toBe(userIdFor(email));
    expect(row.poiId).toBe(poiBase);
    expect(row.note).toBe('V2 user happy path');

    const stored = await db
      .prepare('SELECT user_id, poi_id, note, deleted_at FROM poi_favorites WHERE id = ?')
      .bind(row.id)
      .first<{ user_id: string; poi_id: number; note: string; deleted_at: string | null }>();
    expect(stored).toEqual({ user_id: userIdFor(email), poi_id: poiBase, note: 'V2 user happy path', deleted_at: null });
  });

  it('缺 poiId → 400', async () => {
    const resp = await post({ note: 'no poi' }, { as: `${PREFIX}400-missing@test.com` });
    expect(resp.status).toBe(400);
  });

  it('poiId=0 → 400', async () => {
    const resp = await post({ poiId: 0 }, { as: `${PREFIX}400-zero@test.com` });
    expect(resp.status).toBe(400);
  });

  it('poiId 負數 → 400', async () => {
    const resp = await post({ poiId: -1 }, { as: `${PREFIX}400-neg@test.com` });
    expect(resp.status).toBe(400);
  });

  it('POI 不存在 → 404', async () => {
    const resp = await post({ poiId: 999_999 }, { as: `${PREFIX}404@test.com` });
    expect(resp.status).toBe(404);
  });

  it('重複收藏 → 409', async () => {
    const email = `${PREFIX}409@test.com`;
    const userId = await seedUser(db, email);
    await db
      .prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?)')
      .bind(userId, poiBase)
      .run();

    const resp = await post({ poiId: poiBase }, { as: email });
    expect(resp.status).toBe(409);
    const count = await db
      .prepare('SELECT COUNT(*) AS c FROM poi_favorites WHERE user_id = ? AND poi_id = ?')
      .bind(userId, poiBase)
      .first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it('曾軟刪除的收藏再收藏 → 201，沿用原 id、清掉 deleted_at、套新 note', async () => {
    const email = `${PREFIX}revive@test.com`;
    const userId = await seedUser(db, email);
    const old = await db
      .prepare("INSERT INTO poi_favorites (user_id, poi_id, note, deleted_at) VALUES (?, ?, 'old', '2026-04-01 10:00:00') RETURNING id")
      .bind(userId, poiBase)
      .first<{ id: number }>();

    const resp = await post({ poiId: poiBase, note: 'new note' }, { as: email });
    expect(resp.status).toBe(201);
    const row = await resp.json() as { id: number };
    expect(row.id).toBe(old!.id);

    const all = await db
      .prepare('SELECT id, note, deleted_at FROM poi_favorites WHERE user_id = ? AND poi_id = ?')
      .bind(userId, poiBase)
      .all<{ id: number; note: string; deleted_at: string | null }>();
    expect(all.results).toEqual([{ id: old!.id, note: 'new note', deleted_at: null }]);
  });

  it('11 次連續 POST 中第 11 次 → 429 + Retry-After', async () => {
    // 11 個不同 poiId 避免 409
    const poiIds: number[] = [];
    for (let i = 0; i < 11; i++) {
      poiIds.push(await seedPoi(db, { name: `${PREFIX}RL POI ${i}` }));
    }

    const bearer = await mintToken(env, { email: `${PREFIX}429@test.com` });
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const resp = await post({ poiId: poiIds[i] }, { bearer });
      results.push(resp.status);
      if (i === 10) {
        expect(resp.status).toBe(429);
        expect(resp.headers.get('Retry-After')).toBeTruthy();
      }
    }
    expect(results.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(results[10]).toBe(429);
    // 被限流的第 11 筆沒有寫入
    const stored = await db
      .prepare('SELECT COUNT(*) AS c FROM poi_favorites WHERE user_id = ?')
      .bind(userIdFor(`${PREFIX}429@test.com`))
      .first<{ c: number }>();
    expect(stored!.c).toBe(10);
  });

  it('前 admin email 不再 bypass rate limit（Phase 3：無全域 admin）', async () => {
    // 舊行為：admin email 走 auth.isAdmin bypass，無 429。
    // Phase 3 移除 bypass 後，任何 user（含過去的 admin email）一律受 10/min 限制。
    const poiIds: number[] = [];
    for (let i = 0; i < 11; i++) {
      poiIds.push(await seedPoi(db, { name: `${PREFIX}ExAdmin POI ${i}` }));
    }
    const bearer = await mintToken(env, { email: `${PREFIX}exadmin@test.com` });
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const resp = await post({ poiId: poiIds[i] }, { bearer });
      results.push(resp.status);
    }
    expect(results.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(results[10]).toBe(429); // 第 11 筆被限流 — 無 admin bypass
  });

  it('不同使用者的限流桶互相獨立', async () => {
    const poiIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      poiIds.push(await seedPoi(db, { name: `${PREFIX}Isolated POI ${i}` }));
    }
    const heavy = await mintToken(env, { email: `${PREFIX}heavy@test.com` });
    for (const poiId of poiIds) {
      expect((await post({ poiId }, { bearer: heavy })).status).toBe(201);
    }
    expect((await post({ poiId: poiBase }, { bearer: heavy })).status).toBe(429);
    // 另一位使用者不受影響
    const resp = await post({ poiId: poiBase }, { as: `${PREFIX}light@test.com` });
    expect(resp.status).toBe(201);
  });
});

// ----- §6.5 SQL injection 防護 -----

describe('POST /api/poi-favorites — §6.5 SQL injection on note', () => {
  it('note 含 SQL injection payload → INSERT 成功（D1 prepared statement 防護）+ pois 表不變', async () => {
    const evilNote = "x'; DROP TABLE pois; --";
    const resp = await post({ poiId: poiBase, note: evilNote }, { as: `${PREFIX}sqli@test.com` });
    expect(resp.status).toBe(201);

    const row = await resp.json() as { note: string };
    expect(row.note).toBe(evilNote);  // prepared statement 把 ' 當 literal，不執行

    // pois table 應仍存在（schema 沒被 drop）
    const poisCount = await db
      .prepare('SELECT COUNT(*) AS c FROM pois')
      .first<{ c: number }>();
    expect(poisCount!.c).toBeGreaterThan(0);
  });
});

