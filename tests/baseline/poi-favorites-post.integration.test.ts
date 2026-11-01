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
import { mockEnv, seedPoi, seedUser, seedTrip, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { mintToken, companionToken, seedTripRequest, cleanupFavorites, TP_REQUEST_CLIENT_ID } from './favorites-http';
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

const COMPANION = { 'X-Request-Scope': 'companion' };

async function newTripRequest(status?: string): Promise<number> {
  const tripId = `${PREFIX}trip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await seedTrip(db, { id: tripId, owner: SUBMITTER_EMAIL });
  const id = await seedTripRequest(db, { tripId, submittedBy: SUBMITTER_EMAIL, status });
  requestIds.push(id);
  return id;
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

// ----- §6.2 companion 成功 -----

describe('POST /api/poi-favorites — §6.2 companion happy path', () => {
  it('valid companion 三 gate + companionRequestId → 201 + audit_log + companion_request_actions', async () => {
    const requestId = await newTripRequest();
    const resp = await post(
      { companionRequestId: requestId, poiId: poiBase, note: 'companion add' },
      { bearer: await companionToken(env) },
      COMPANION,
    );
    expect(resp.status).toBe(201);
    const row = await resp.json() as { id: number; userId: string; poiId: number };
    expect(row.id).toBeGreaterThan(0);
    expect(row.poiId).toBe(poiBase);

    // user_id 應對映 trip_requests.submitted_by → users.id
    const expected = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(SUBMITTER_EMAIL)
      .first<{ id: string }>();
    expect(row.userId).toBe(expected!.id);

    // companion_request_actions 1 row（直查 D1 — 不過 json() camelCase 轉換）
    const actions = await db
      .prepare('SELECT action, poi_id FROM companion_request_actions WHERE request_id = ?')
      .bind(requestId)
      .all<{ action: string; poi_id: number | null }>();
    expect(actions.results).toHaveLength(1);
    expect(actions.results[0]!.action).toBe('favorite_create');
    expect(actions.results[0]!.poi_id).toBe(poiBase);

    // audit_log 多 1 row
    const audit = await db
      .prepare(
        `SELECT changed_by, trip_id, action, record_id, request_id FROM audit_log
         WHERE record_id = ? AND table_name = 'poi_favorites' ORDER BY id DESC LIMIT 1`,
      )
      .bind(row.id)
      .first<{ changed_by: string; trip_id: string; action: string; record_id: number; request_id: number }>();
    expect(audit).not.toBeNull();
    expect(audit!.changed_by).toBe(`companion:${requestId}`);
    expect(audit!.trip_id).toBe('system:companion');
    expect(audit!.action).toBe('insert');
    expect(audit!.request_id).toBe(requestId);
  });

  it('companion 請求已非 processing（completed）→ 401 且不寫入收藏', async () => {
    const requestId = await newTripRequest('completed');
    const resp = await post(
      { companionRequestId: requestId, poiId: poiBase },
      { bearer: await companionToken(env) },
      COMPANION,
    );
    expect(resp.status).toBe(401);
    const stored = await db
      .prepare('SELECT id FROM poi_favorites WHERE poi_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)')
      .bind(poiBase, SUBMITTER_EMAIL)
      .first();
    expect(stored).toBeNull();
    const audit = await db
      .prepare(`SELECT companion_failure_reason FROM audit_log WHERE trip_id = 'system:companion' AND request_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(requestId)
      .first<{ companion_failure_reason: string }>();
    expect(audit!.companion_failure_reason).toBe('status_completed');
  });
});

// ----- §6.3 companion quota -----

describe('POST /api/poi-favorites — §6.3 companion quota', () => {
  it('同 requestId 同 action 第 2 次（不同 poiId）→ 409 COMPANION_QUOTA_EXCEEDED', async () => {
    const requestId = await newTripRequest();
    const poi2 = await seedPoi(db, { name: `${PREFIX}companion second poi` });
    const bearer = await companionToken(env);

    // 第 1 次 favorite_create — 應成功
    const r1 = await post({ companionRequestId: requestId, poiId: poiBase }, { bearer }, COMPANION);
    expect(r1.status).toBe(201);

    // 第 2 次（不同 poi）→ companion_request_actions UNIQUE → 409 COMPANION_QUOTA_EXCEEDED
    const r2 = await post({ companionRequestId: requestId, poiId: poi2 }, { bearer }, COMPANION);
    expect(r2.status).toBe(409);
    const json = await r2.json() as { error: { code: string } };
    expect(json.error.code).toBe('COMPANION_QUOTA_EXCEEDED');
    const second = await db
      .prepare('SELECT id FROM poi_favorites WHERE poi_id = ?')
      .bind(poi2)
      .first();
    expect(second).toBeNull();
  });
});

// ----- §6.4 service token 無 companion gate → 401 -----

describe('POST /api/poi-favorites — §6.4 service token without companion gate', () => {
  it('service token 缺 companion scope → fail-closed 401', async () => {
    const requestId = await newTripRequest();
    const resp = await post(
      { companionRequestId: requestId, poiId: poiBase },
      { bearer: await companionToken(env, { scopes: ['admin'] }) }, // 缺 companion
      COMPANION,
    );
    expect(resp.status).toBe(401);
  });

  it('service token clientId 不對 → fail-closed 401', async () => {
    const requestId = await newTripRequest();
    const resp = await post(
      { companionRequestId: requestId, poiId: poiBase },
      { bearer: await companionToken(env, { clientId: 'rogue-cli' }) },
      COMPANION,
    );
    expect(resp.status).toBe(401);
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

// ----- §6.7 burst concurrent → mix 201 / 409 / 429 -----

describe('POST /api/poi-favorites — §6.7 burst concurrent companion', () => {
  it('100 burst concurrent 同 requestId → companion_request_actions UNIQUE 防護（v2.33.105 SEC-2 post-gate bucket order）', async () => {
    const requestId = await newTripRequest();
    // 100 個不同 poiId（避免 V2 user UNIQUE 撞）
    const poiIds: number[] = [];
    for (let i = 0; i < 100; i++) {
      poiIds.push(await seedPoi(db, { name: `${PREFIX}Burst POI ${i}` }));
    }

    const bearer = await companionToken(env);
    const promises: Promise<Response>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(post({ companionRequestId: requestId, poiId: poiIds[i] }, { bearer }, COMPANION));
    }

    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);
    const counts = statuses.reduce<Record<number, number>>(
      (acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }),
      {},
    );

    // v2.33.105 SEC-2: actor resolve 順序前移，per-requestId bucket bump 改在
    // resolve 之後。100 個同 (requestId, action='favorite_create') concurrent →
    // companion_request_actions UNIQUE 在第一個 INSERT 之後鎖死，後續 99 個 throw
    // COMPANION_QUOTA_EXCEEDED → 409。100 < 200 pre-gate IP 不會觸 429。
    expect(counts[201] ?? 0).toBe(1);
    expect(counts[409] ?? 0).toBe(99);
    // 不應全部 201（會破壞 quota 防護）
    expect(counts[201] ?? 0).toBeLessThan(10);
    // 真實 D1：只有 1 筆 companion 動作落地
    const actions = await db
      .prepare('SELECT COUNT(*) AS c FROM companion_request_actions WHERE request_id = ?')
      .bind(requestId)
      .first<{ c: number }>();
    expect(actions!.c).toBe(1);
  });
});

// ----- §6.8 self-reported header without OAuth scope -----

describe('POST /api/poi-favorites — §6.8 self-reported header without OAuth scope', () => {
  it('header companion + auth 無 companion scope → fail-closed 401（V2 user fallback userId null）', async () => {
    const requestId = await newTripRequest();
    const resp = await post(
      { companionRequestId: requestId, poiId: poiBase },
      { bearer: await companionToken(env, { scopes: ['admin'] }) }, // self-reported header without OAuth gate
      COMPANION,
    );
    expect(resp.status).toBe(401);

    // server 端 audit_log 應寫 self_reported_scope
    const audit = await db
      .prepare(
        `SELECT companion_failure_reason FROM audit_log
         WHERE trip_id = 'system:companion' AND request_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(requestId)
      .first<{ companion_failure_reason: string }>();
    expect(audit!.companion_failure_reason).toBe('self_reported_scope');
  });
});
