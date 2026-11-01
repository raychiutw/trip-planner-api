/**
 * Integration test — GET /api/poi-favorites (poi-favorites-rename §7)
 * 走 HTTP 邊界（tests/api/http.ts）：認證用真實 bearer token（含 companion／service／受限 token），
 * 經過 middleware，不直接呼叫 handler。
 *
 * Cover：
 *   §7.1.a V2 user 200 + 包含 usages 陣列
 *   §7.1.b anonymous 200 + 空陣列（不拋 401）
 *   §7.1.c cross-user data leak 防護：A 不能看到 B 私 trip 中收藏 POI 的 usages
 *   §7.2.a companion 三 gate + ?companionRequestId=N → 回該 submitter 的 favorites pool
 *   §7.2.b companion gate 失敗（缺 OAuth scope）→ 401
 *
 * 共用 D1：email／trip／POI 一律用 `favget-` 前綴，結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, seedUser, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { mintToken, companionToken, seedTripRequest, cleanupFavorites, TP_REQUEST_CLIENT_ID } from './favorites-http';
import type { Env } from '../../src/env';

const PREFIX = 'favget-';
const SUBMITTER_EMAIL = `${PREFIX}submitter@test.com`;
const URL_BASE = 'https://test.com/api/poi-favorites';

let db: D1Database;
let env: Env;
let api: Api;
const requestIds: number[] = [];

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db, { TP_REQUEST_CLIENT_ID });
  api = createApi({ env });
  await seedUser(db, SUBMITTER_EMAIL);
});

afterAll(async () => {
  await cleanupFavorites(db, PREFIX, requestIds);
  await disposeMiniflare();
});

async function newTripRequest(): Promise<number> {
  const tripId = `${PREFIX}trip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await seedTrip(db, { id: tripId, owner: SUBMITTER_EMAIL });
  const id = await seedTripRequest(db, { tripId, submittedBy: SUBMITTER_EMAIL });
  requestIds.push(id);
  return id;
}

// ----- §7.1 V2 user / anonymous -----

describe('GET /api/poi-favorites — §7.1 V2 user / anonymous', () => {
  it('V2 user 200 + 自己的 favorites + usages 陣列', async () => {
    const email = `${PREFIX}list@test.com`;
    const userId = await seedUser(db, email);
    const poiX = await seedPoi(db, { name: `${PREFIX}GET POI X` });
    await db
      .prepare("INSERT INTO poi_favorites (user_id, poi_id, favorited_at, note) VALUES (?, ?, '2026-04-25 10:00:00', ?)")
      .bind(userId, poiX, 'fav note')
      .run();

    const resp = await api.get(URL_BASE, { as: email });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<{ poiId: number; poiName: string; usages: unknown[] }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.poiId).toBe(poiX);
    expect(data[0]!.poiName).toBe(`${PREFIX}GET POI X`);
    expect(Array.isArray(data[0]!.usages)).toBe(true);
  });

  // v2.29.0: 「contextual trip_pois usage」test removed — trip_pois table DROPPED。
  // usage 來源改為 trip_entry_pois + trip_days.hotel_poi_id（測在其他 it 涵蓋）。

  it('anonymous（無 auth）→ 401，不洩漏任何收藏', async () => {
    // 原本直呼 handler（auth = null）得到 200 + []；走 HTTP 邊界後 middleware 先擋下，
    // handler 的 null-auth 分支從外部打不到，真實行為是 401（見 PR 說明）。
    const resp = await api.get(URL_BASE);
    expect(resp.status).toBe(401);
    const text = await resp.text();
    expect(text).not.toContain('poiId');
  });

  it('service token without userId（無 companion header）→ 200 + 空陣列', async () => {
    // service token without companion path should be treated like anonymous-with-token
    const bearer = await companionToken(env); // userId null + scopes 含 companion，但無 X-Request-Scope header
    const resp = await api.get(URL_BASE, { bearer });
    expect(resp.status).toBe(200);
    const data = await resp.json() as unknown[];
    expect(data).toEqual([]);
  });

  it('受限 token（restrict_trip）→ 403，不可列舉 owner 跨 trip 收藏（containment 回歸；security-auditor HIGH）', async () => {
    // v2.55.56 downscoped token user_id=owner；未擋則此 user-path 會列舉 owner 全跨 trip 收藏。
    const email = `${PREFIX}restrict@test.com`;
    const userId = await seedUser(db, email);
    const poiR = await seedPoi(db, { name: `${PREFIX}restrict GET POI` });
    await db.prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?)').bind(userId, poiR).run();

    const bearer = await mintToken(env, { email, restrictTrip: 'some-trip' });
    const resp = await api.get(URL_BASE, { bearer });
    expect(resp.status).toBe(403);
  });

  it('已軟刪除（deleted_at）的收藏不列出；多筆依 favorited_at 由新到舊', async () => {
    const email = `${PREFIX}soft@test.com`;
    const userId = await seedUser(db, email);
    const poiOld = await seedPoi(db, { name: `${PREFIX}soft old` });
    const poiNew = await seedPoi(db, { name: `${PREFIX}soft new` });
    const poiGone = await seedPoi(db, { name: `${PREFIX}soft gone` });
    await db.prepare("INSERT INTO poi_favorites (user_id, poi_id, favorited_at) VALUES (?, ?, '2026-04-01 10:00:00')").bind(userId, poiOld).run();
    await db.prepare("INSERT INTO poi_favorites (user_id, poi_id, favorited_at) VALUES (?, ?, '2026-04-20 10:00:00')").bind(userId, poiNew).run();
    await db.prepare("INSERT INTO poi_favorites (user_id, poi_id, favorited_at, deleted_at) VALUES (?, ?, '2026-04-25 10:00:00', '2026-04-26 10:00:00')").bind(userId, poiGone).run();

    const resp = await api.get(URL_BASE, { as: email });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<{ poiId: number }>;
    expect(data.map((d) => d.poiId)).toEqual([poiNew, poiOld]);
  });

  it('usages 列出自己行程中使用該 POI 的位置（entry 與住宿）', async () => {
    const email = `${PREFIX}usage@test.com`;
    const userId = await seedUser(db, email);
    const poi = await seedPoi(db, { name: `${PREFIX}usage POI` });
    await db.prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?)').bind(userId, poi).run();

    const tripId = `${PREFIX}usage-trip`;
    await seedTrip(db, { id: tripId, owner: email });
    const day1 = await db.prepare('SELECT id FROM trip_days WHERE trip_id = ? AND day_num = 1').bind(tripId).first<{ id: number }>();
    const day2 = await db.prepare('SELECT id FROM trip_days WHERE trip_id = ? AND day_num = 2').bind(tripId).first<{ id: number }>();
    const entry = await db.prepare('INSERT INTO trip_entries (day_id, sort_order) VALUES (?, 0) RETURNING id').bind(day1!.id).first<{ id: number }>();
    await db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, poi).run();
    await db.prepare('UPDATE trip_days SET hotel_poi_id = ? WHERE id = ?').bind(poi, day2!.id).run();

    const resp = await api.get(URL_BASE, { as: email });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<{ poiId: number; usages: Array<{ tripId: string; dayNum: number; entryId: number | null }> }>;
    const usages = data.find((d) => d.poiId === poi)!.usages;
    expect(usages).toHaveLength(2);
    expect(usages.every((u) => u.tripId === tripId)).toBe(true);
    expect(usages.find((u) => u.dayNum === 1)!.entryId).toBe(entry!.id);
    expect(usages.find((u) => u.dayNum === 2)!.entryId).toBeNull();
  });

  it('cross-user data leak 防護：A 不能看到 B 私 trip 中收藏 POI 的 usages', async () => {
    const emailA = `${PREFIX}leak-a@test.com`;
    const emailB = `${PREFIX}leak-b@test.com`;
    const userA = await seedUser(db, emailA);
    const userB = await seedUser(db, emailB);
    const sharedPoi = await seedPoi(db, { name: `${PREFIX}Shared POI` });

    // 兩 user 都收藏同一 POI
    await db.prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?)').bind(userA, sharedPoi).run();
    await db.prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?)').bind(userB, sharedPoi).run();

    // B 在自己私 trip 中放這個 POI
    const privateTripId = `${PREFIX}private-trip-of-b`;
    await seedTrip(db, { id: privateTripId, owner: emailB });
    const dayRow = await db
      .prepare('SELECT id FROM trip_days WHERE trip_id = ? LIMIT 1')
      .bind(privateTripId)
      .first<{ id: number }>();
    // v2.29.0: trip_entries.poi_id DROPPED. master 走 trip_entry_pois sort_order=1。
    const entry = await db
      .prepare(
        `INSERT INTO trip_entries (day_id, sort_order)
         VALUES (?, 0) RETURNING id`,
      )
      .bind(dayRow!.id)
      .first<{ id: number }>();
    await db
      .prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)')
      .bind(entry!.id, sharedPoi)
      .run();

    // A 查自己收藏 — usages 不該揭露 B 的私 trip
    const resp = await api.get(URL_BASE, { as: emailA });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<{ poiId: number; usages: Array<{ tripId: string }> }>;
    const sharedFavorite = data.find((d) => d.poiId === sharedPoi);
    expect(sharedFavorite).toBeDefined();
    // A 不該看到 B 的 trip
    expect(sharedFavorite!.usages.find((u) => u.tripId === privateTripId)).toBeUndefined();
  });
});

// ----- §7.2 companion -----

describe('GET /api/poi-favorites — §7.2 companion', () => {
  it('companion 三 gate + ?companionRequestId=N → 回該 submitter 的 favorites pool', async () => {
    const requestId = await newTripRequest();
    // submitter 自己有收藏
    const submitterUserRow = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(SUBMITTER_EMAIL)
      .first<{ id: string }>();
    const submitterUserId = submitterUserRow!.id;
    const poiSubmitter = await seedPoi(db, { name: `${PREFIX}Submitter favorite` });
    await db
      .prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?)')
      .bind(submitterUserId, poiSubmitter)
      .run();

    const resp = await api.get(`${URL_BASE}?companionRequestId=${requestId}`, {
      bearer: await companionToken(env),
      headers: { 'X-Request-Scope': 'companion' },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<{ poiId: number; userId: string }>;
    const fav = data.find((d) => d.poiId === poiSubmitter);
    expect(fav).toBeDefined();
    expect(fav!.userId).toBe(submitterUserId);
  });

  it('companion gate 失敗（缺 OAuth scope）→ 401', async () => {
    const requestId = await newTripRequest();
    const resp = await api.get(`${URL_BASE}?companionRequestId=${requestId}`, {
      bearer: await companionToken(env, { scopes: ['admin'] }), // 缺 companion scope
      headers: { 'X-Request-Scope': 'companion' },
    });
    expect(resp.status).toBe(401);
  });

  it('companion 缺 ?companionRequestId 查詢 → 401（resolver 走 invalid_request_id）', async () => {
    const resp = await api.get(URL_BASE, {
      bearer: await companionToken(env),
      headers: { 'X-Request-Scope': 'companion' },
    });
    expect(resp.status).toBe(401);
  });
});
