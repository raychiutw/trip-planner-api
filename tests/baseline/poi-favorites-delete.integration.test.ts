/**
 * Integration test — DELETE /api/poi-favorites/:id (poi-favorites-rename §8)
 * 走 HTTP 邊界（tests/api/http.ts）：認證用真實 bearer token（含 companion／service／受限 token），
 * 經過 middleware，不直接呼叫 handler。
 *
 * Cover：
 *   §8.1 V2 user owner 204 / 非 owner 403 / 不存在 404
 *   §8.2 companion 三 gate + companionRequestId 對應 submitter == row.user_id → 204
 *        + audit + companion_request_actions (action='favorite_delete')
 *   §8.3 companion 越權刪別 user 收藏 → fail-closed 401
 *        + admin bypass ownership
 *
 * 共用 D1：email／trip／POI 一律用 `favdel-` 前綴，並用專屬 CF-Connecting-IP 隔離 pre-gate 的 IP 限流桶，
 * 結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, seedUser } from './helpers';
import { createApi, type Api } from './http';
import { mintToken, cleanupFavorites, TP_REQUEST_CLIENT_ID } from './favorites-http';
import type { Env } from '../../src/env';

const PREFIX = 'favdel-';
const SUBMITTER_EMAIL = `${PREFIX}submitter@test.com`;
const TEST_IP = '198.51.100.22';

let db: D1Database;
let env: Env;
let api: Api;
const requestIds: number[] = [];

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { TP_REQUEST_CLIENT_ID, ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
  await seedUser(db, SUBMITTER_EMAIL);
});

afterAll(async () => {
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
  await cleanupFavorites(db, PREFIX, requestIds);
  await disposeMiniflare();
});

beforeEach(async () => {
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
});

// ----- helpers -----

type Auth = { as: string } | { bearer: string } | Record<string, never>;

function del(id: number | string, auth: Auth, headers: Record<string, string> = {}, body?: unknown): Promise<Response> {
  return api.request('DELETE', `https://test.com/api/poi-favorites/${id}`, {
    json: body,
    headers: { 'CF-Connecting-IP': TEST_IP, ...headers },
    ...auth,
  });
}

async function seedPoiFavorite(userId: string, poiId: number): Promise<number> {
  const row = await db
    .prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?) RETURNING id')
    .bind(userId, poiId)
    .first<{ id: number }>();
  return row!.id;
}

describe('DELETE /api/poi-favorites/:id — restrict_trip containment（回歸；security-auditor HIGH）', () => {
  it('受限 token 刪收藏 → 403（favorites user-scoped，restrict token 不可碰）', async () => {
    const email = `${PREFIX}restrict@test.com`;
    const userId = await seedUser(db, email);
    const poiId = await seedPoi(db, { name: `${PREFIX}restrict POI` });
    const favId = await seedPoiFavorite(userId, poiId);

    const bearer = await mintToken(env, { email, restrictTrip: 'some-trip' });
    const resp = await del(favId, { bearer });
    expect(resp.status).toBe(403);
    const after = await db.prepare('SELECT deleted_at FROM poi_favorites WHERE id = ?').bind(favId).first<{ deleted_at: string | null }>();
    expect(after!.deleted_at).toBeNull();
  });
});

// ----- §8.1 V2 user -----

describe('DELETE /api/poi-favorites/:id — §8.1 V2 user', () => {
  it('owner → 204 + row deleted', async () => {
    const email = `${PREFIX}owner@test.com`;
    const userId = await seedUser(db, email);
    const poiId = await seedPoi(db, { name: `${PREFIX}POI to delete` });
    const favId = await seedPoiFavorite(userId, poiId);

    const resp = await del(favId, { as: email });
    expect(resp.status).toBe(204);

    // spec §2.1：soft-delete — row 保留但 deleted_at 已寫、且不在 active 查詢內（restore 可復原）。
    const after = await db
      .prepare('SELECT deleted_at FROM poi_favorites WHERE id = ?')
      .bind(favId)
      .first<{ deleted_at: string | null }>();
    expect(after?.deleted_at).not.toBeNull();
    expect(typeof after?.deleted_at).toBe('string'); // row 仍在（非 hard delete）且有 tombstone
    const active = await db
      .prepare('SELECT id FROM poi_favorites WHERE id = ? AND deleted_at IS NULL')
      .bind(favId)
      .first();
    expect(active).toBeNull();

    // V2 user 刪除也寫 audit（forensic trail，與 INSERT 對稱）：user 路徑 trip_id='user'、changed_by=email
    const audit = await db
      .prepare(`SELECT changed_by, trip_id, action FROM audit_log WHERE record_id = ? AND table_name = 'poi_favorites' ORDER BY id DESC LIMIT 1`)
      .bind(favId)
      .first<{ changed_by: string; trip_id: string; action: string }>();
    expect(audit).toEqual({ changed_by: email, trip_id: 'user', action: 'delete' });
    await db.prepare(`DELETE FROM audit_log WHERE record_id = ? AND table_name = 'poi_favorites' AND trip_id = 'user'`).bind(favId).run();
  });

  it('已取消的收藏再刪 → 204 idempotent，deleted_at 不被改寫、不重複寫 audit', async () => {
    const email = `${PREFIX}idem@test.com`;
    const userId = await seedUser(db, email);
    const poiId = await seedPoi(db, { name: `${PREFIX}POI idem` });
    const favId = await seedPoiFavorite(userId, poiId);
    await db.prepare("UPDATE poi_favorites SET deleted_at = '2026-04-01 10:00:00' WHERE id = ?").bind(favId).run();

    const resp = await del(favId, { as: email });
    expect(resp.status).toBe(204);
    const after = await db.prepare('SELECT deleted_at FROM poi_favorites WHERE id = ?').bind(favId).first<{ deleted_at: string }>();
    expect(after!.deleted_at).toBe('2026-04-01 10:00:00');
    const audits = await db
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE record_id = ? AND table_name = 'poi_favorites' AND trip_id = 'user'`)
      .bind(favId)
      .first<{ c: number }>();
    expect(audits!.c).toBe(0);
  });

  it('id 不是正整數 → 400', async () => {
    const resp = await del('abc', { as: `${PREFIX}badid@test.com` });
    expect(resp.status).toBe(400);
  });

  it('非 owner → 403 + row 仍存在', async () => {
    const ownerId = await seedUser(db, `${PREFIX}owner-403@test.com`);
    const poiId = await seedPoi(db, { name: `${PREFIX}POI 403` });
    const favId = await seedPoiFavorite(ownerId, poiId);

    const resp = await del(favId, { as: `${PREFIX}attacker-403@test.com` });
    expect(resp.status).toBe(403);

    const still = await db.prepare('SELECT id FROM poi_favorites WHERE id = ? AND deleted_at IS NULL').bind(favId).first();
    expect(still).not.toBeNull();
  });

  it('id 不存在 → 404', async () => {
    const resp = await del(999_999, { as: `${PREFIX}nf@test.com` });
    expect(resp.status).toBe(404);
  });

  it('前 admin 不能刪他人收藏（Phase 3：無 admin bypass）→ 403', async () => {
    // 舊行為：admin email 走 isAdmin bypass，可刪任何人收藏 → 204。
    // Phase 3 移除 bypass 後，assertFavoriteOwnership 純比對 owner → 非 owner 一律 PERM_DENIED。
    const ownerId = await seedUser(db, `${PREFIX}owner-target@test.com`);
    const poiId = await seedPoi(db, { name: `${PREFIX}POI exadmin del` });
    const favId = await seedPoiFavorite(ownerId, poiId);

    const resp = await del(favId, { as: `${PREFIX}exadmin@test.com` });
    expect(resp.status).toBe(403);

    // 收藏未被刪除
    const still = await db.prepare('SELECT id FROM poi_favorites WHERE id = ? AND deleted_at IS NULL').bind(favId).first();
    expect(still).not.toBeNull();
  });

  it('無 auth（瀏覽器帶合法 Origin）→ 401', async () => {
    const resp = await del(1, {}, { Origin: 'https://trip-planner-dby.pages.dev' });
    expect(resp.status).toBe(401);
  });

  // 已移除：「無 auth 且無 Origin → 403（CSRF 閘）」——新 api 沒有 cookie session／CSRF 閘（行為變更）；匿名請求一律 401，已由上一條涵蓋。
});

