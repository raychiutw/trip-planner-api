/**
 * Integration test — POST /api/poi-favorites/:id/add-to-trip (poi-favorites-rename §9)
 * 走 HTTP 邊界（tests/api/http.ts）：認證用真實 bearer token（含 companion／受限 token），
 * 經過 middleware，不直接呼叫 handler。
 *
 * 4-field 純時間驅動 form：{ tripId, dayNum, startTime, endTime } — 無 position / anchorEntryId。
 *
 * Cover：
 *   §9.1 4 fields validation：tripId / dayNum / startTime / endTime 必填
 *   §9.2 startTime 或 endTime 缺失 → 400 DATA_VALIDATION
 *   §9.3 body 含 legacy position 或 anchorEntryId → 400「欄位已廢除」
 *   §9.4 startTime '12:00' 加進已有 11:00-12:00 entry 的 day → server 計算 sort_order 排到後面
 *   §9.5 startTime '13:00' 加進已有 12:00-14:00 entry 的 day → 409 CONFLICT + conflictWith
 *   §9.6 V2 user 成功 201 + entry + trip_entry_pois 各 1 row
 *   §9.7 companion case：valid 三 gate + companionRequestId + ownership match → 201 + audit_log companion sentinel
 *
 * 共用 D1：email／trip／POI 一律用 `favatt-` 前綴，並用專屬 CF-Connecting-IP 隔離 pre-gate 的 IP 限流桶，
 * 結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi, seedUser, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { mintToken, companionToken, seedTripRequest, cleanupFavorites, TP_REQUEST_CLIENT_ID } from './favorites-http';
import type { Env } from '../../src/env';

const PREFIX = 'favatt-';
const SUBMITTER_EMAIL = `${PREFIX}submitter@test.com`;
const TEST_IP = '198.51.100.23';
const COMPANION = { 'X-Request-Scope': 'companion' };

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
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
  await cleanupFavorites(db, PREFIX, requestIds);
  await disposeMiniflare();
});

beforeEach(async () => {
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
});

// ----- helpers -----

type Auth = { as: string } | { bearer: string };

function addToTrip(favId: number | string, body: Record<string, unknown>, auth: Auth, headers: Record<string, string> = {}): Promise<Response> {
  return api.request('POST', `https://test.com/api/poi-favorites/${favId}/add-to-trip`, {
    json: body,
    headers: { 'CF-Connecting-IP': TEST_IP, ...headers },
    ...auth,
  });
}

async function seedFavorite(opts: { email: string; poiName?: string; note?: string }): Promise<{ favId: number; userId: string; poiId: number }> {
  const userId = await seedUser(db, opts.email);
  const poiId = await seedPoi(db, { name: `${PREFIX}${opts.poiName ?? `POI for ${opts.email}`}` });
  const favRow = await db
    .prepare('INSERT INTO poi_favorites (user_id, poi_id, note) VALUES (?, ?, ?) RETURNING id')
    .bind(userId, poiId, opts.note ?? null)
    .first<{ id: number }>();
  return { favId: favRow!.id, userId, poiId };
}

async function seedAddTripFixture(opts: { tripId: string; ownerEmail: string }) {
  await seedTrip(db, { id: opts.tripId, owner: opts.ownerEmail, days: 3 });
}

async function dayId(tripId: string, dayNum: number): Promise<number> {
  const row = await db
    .prepare('SELECT id FROM trip_days WHERE trip_id = ? AND day_num = ?')
    .bind(tripId, dayNum)
    .first<{ id: number }>();
  return row!.id;
}

async function entriesOfDay(day: number) {
  const r = await db
    .prepare('SELECT id, sort_order, start_time, end_time FROM trip_entries WHERE day_id = ? ORDER BY sort_order')
    .bind(day)
    .all<{ id: number; sort_order: number; start_time: string | null; end_time: string | null }>();
  return r.results;
}

async function newTripRequest(): Promise<{ requestId: number }> {
  const tripId = `${PREFIX}req-trip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await seedTrip(db, { id: tripId, owner: SUBMITTER_EMAIL });
  const requestId = await seedTripRequest(db, { tripId, submittedBy: SUBMITTER_EMAIL });
  requestIds.push(requestId);
  return { requestId };
}

describe('POST /api/poi-favorites/:id/add-to-trip — restrict_trip containment（回歸；security-auditor HIGH）', () => {
  it('受限 token 經收藏 fast-path 加入 trip → 403（即使 tripId===restrictTrip：仍讀 owner 收藏含私 note）', async () => {
    const email = `${PREFIX}restrict@test.com`;
    const tripId = `${PREFIX}restrict-trip`;
    await seedAddTripFixture({ tripId, ownerEmail: email });
    const { favId } = await seedFavorite({ email });

    const bearer = await mintToken(env, { email, restrictTrip: tripId });
    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { bearer });
    expect(resp.status).toBe(403);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });
});

// --- §9.1 4 fields validation ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.1 4 fields validation', () => {
  it('happy path 4 fields → 201', async () => {
    const tripId = `${PREFIX}9-1`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-1@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-1@test.com` });

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: `${PREFIX}9-1@test.com` });
    expect(resp.status).toBe(201);
  });

  it('migration 0078: 收藏 note → master trip_entry_pois.note（不可 silently 遺失）', async () => {
    const tripId = `${PREFIX}9-1-note`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-1-note@test.com` });
    const { favId, poiId } = await seedFavorite({ email: `${PREFIX}9-1-note@test.com`, note: '收藏時記的備註' });

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: `${PREFIX}9-1-note@test.com` });
    expect(resp.status).toBe(201);

    const master = await db
      .prepare(
        `SELECT tep.note FROM trip_entry_pois tep
         JOIN trip_entries e ON e.id = tep.entry_id
         JOIN trip_days d ON d.id = e.day_id
         WHERE d.trip_id = ? AND tep.poi_id = ? AND tep.sort_order = 1`,
      )
      .bind(tripId, poiId)
      .first<{ note: string | null }>();
    expect(master!.note).toBe('收藏時記的備註');
  });

  it('缺 tripId → 400', async () => {
    const { favId } = await seedFavorite({ email: `${PREFIX}9-1-no-trip@test.com` });
    const resp = await addToTrip(favId, { dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: `${PREFIX}9-1-no-trip@test.com` });
    expect(resp.status).toBe(400);
  });

  it('dayNum < 1 → 400', async () => {
    const tripId = `${PREFIX}9-1-day`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-1-day@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-1-day@test.com` });
    const resp = await addToTrip(favId, { tripId, dayNum: 0, startTime: '10:00', endTime: '11:00' }, { as: `${PREFIX}9-1-day@test.com` });
    expect(resp.status).toBe(400);
  });

  it('時間格式不是 HH:MM → 400，不建立 entry', async () => {
    const email = `${PREFIX}9-1-fmt@test.com`;
    const tripId = `${PREFIX}9-1-fmt`;
    await seedAddTripFixture({ tripId, ownerEmail: email });
    const { favId } = await seedFavorite({ email });
    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '9am', endTime: '11:00' }, { as: email });
    expect(resp.status).toBe(400);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });

  it('favoriteId 不是正整數 → 400', async () => {
    const resp = await addToTrip('abc', { tripId: 'x', dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: `${PREFIX}9-1-badid@test.com` });
    expect(resp.status).toBe(400);
  });
});

// --- §9.2 startTime/endTime 缺失 ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.2 time fields required', () => {
  it('缺 startTime → 400', async () => {
    const tripId = `${PREFIX}9-2-no-start`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-2-no-start@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-2-no-start@test.com` });
    const resp = await addToTrip(favId, { tripId, dayNum: 1, endTime: '11:00' }, { as: `${PREFIX}9-2-no-start@test.com` });
    expect(resp.status).toBe(400);
  });

  it('缺 endTime → 400', async () => {
    const tripId = `${PREFIX}9-2-no-end`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-2-no-end@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-2-no-end@test.com` });
    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00' }, { as: `${PREFIX}9-2-no-end@test.com` });
    expect(resp.status).toBe(400);
  });
});

// --- §9.3 legacy fields rejection ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.3 legacy fields rejected', () => {
  it('body 含 position → 400「欄位已廢除」', async () => {
    const tripId = `${PREFIX}9-3-pos`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-3-pos@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-3-pos@test.com` });
    const resp = await addToTrip(
      favId,
      { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00', position: 'append' },
      { as: `${PREFIX}9-3-pos@test.com` },
    );
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: { detail?: string; message?: string } };
    const text = (body.error.detail ?? body.error.message ?? '').toString();
    expect(text).toMatch(/廢除|deprecated|不支援/);
  });

  it('body 含 anchorEntryId → 400「欄位已廢除」', async () => {
    const tripId = `${PREFIX}9-3-anchor`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-3-anchor@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-3-anchor@test.com` });
    const resp = await addToTrip(
      favId,
      { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00', anchorEntryId: 1 },
      { as: `${PREFIX}9-3-anchor@test.com` },
    );
    expect(resp.status).toBe(400);
  });
});

// --- §9.4 sort_order 計算 ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.4 sort_order auto-calc', () => {
  it('startTime 12:00 加進已有 11:00-12:00 entry 的 day → 排到該 entry 之後', async () => {
    const tripId = `${PREFIX}9-4-sort`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-4-sort@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-4-sort@test.com`, poiName: 'POI 9-4' });

    // 已有 entry 11:00-12:00 sort_order=0
    // v2.29.0: trip_entries.time DROPPED, 改寫 start_time/end_time。
    const day1 = await dayId(tripId, 1);
    await db
      .prepare(`INSERT INTO trip_entries (day_id, sort_order, start_time, end_time) VALUES (?, ?, ?, ?)`)
      .bind(day1, 0, '11:00', '12:00')
      .run();

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '12:00', endTime: '13:00' }, { as: `${PREFIX}9-4-sort@test.com` });
    expect(resp.status).toBe(201);

    const data = await resp.json() as { sortOrder: number };
    expect(data.sortOrder).toBe(1); // 排到 0 之後
  });

  it('startTime 早於既有 entry → 插在它之前，既有 entry 往後讓位', async () => {
    const email = `${PREFIX}9-4-before@test.com`;
    const tripId = `${PREFIX}9-4-before`;
    await seedAddTripFixture({ tripId, ownerEmail: email });
    const { favId } = await seedFavorite({ email, poiName: 'POI 9-4 before' });
    const day1 = await dayId(tripId, 1);
    const existing = await db
      .prepare('INSERT INTO trip_entries (day_id, sort_order, start_time, end_time) VALUES (?, 0, ?, ?) RETURNING id')
      .bind(day1, '11:00', '12:00')
      .first<{ id: number }>();

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '09:00', endTime: '10:00' }, { as: email });
    expect(resp.status).toBe(201);
    const data = await resp.json() as { entryId: number; sortOrder: number };
    expect(data.sortOrder).toBe(0);

    const rows = await entriesOfDay(day1);
    expect(rows.map((r) => r.id)).toEqual([data.entryId, existing!.id]);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1]);
  });
});

// --- §9.5 conflict ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.5 conflict 409', () => {
  it('startTime 13:00 加進已有 12:00-14:00 entry 的 day → 409 + conflictWith', async () => {
    const tripId = `${PREFIX}9-5-conflict`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-5@test.com` });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-5@test.com` });

    const day1 = await dayId(tripId, 1);
    // v2.29.0: trip_entries.time DROPPED, 改寫 start_time/end_time。
    const existingEntry = await db
      .prepare(`INSERT INTO trip_entries (day_id, sort_order, start_time, end_time) VALUES (?, ?, ?, ?) RETURNING id`)
      .bind(day1, 0, '12:00', '14:00')
      .first<{ id: number }>();
    const existingPoiId = await seedPoi(db, { name: `${PREFIX}Lunch POI`, type: 'restaurant' });
    await db
      .prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)')
      .bind(existingEntry!.id, existingPoiId)
      .run();

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '13:00', endTime: '14:30' }, { as: `${PREFIX}9-5@test.com` });
    expect(resp.status).toBe(409);
    const data = await resp.json() as { conflictWith?: { time: string; title: string } };
    expect(data.conflictWith).toBeDefined();
    expect(data.conflictWith!.time).toBe('12:00-14:00');
    expect(data.conflictWith!.title).toBe(`${PREFIX}Lunch POI`);
    // 衝突時沒有新增 entry
    expect(await entriesOfDay(day1)).toHaveLength(1);
  });
});

// --- §9.6 V2 user 成功 ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.6 V2 user happy path', () => {
  it('valid V2 user → 201 + entry + trip_entry_pois 各 1 row', async () => {
    const tripId = `${PREFIX}9-6`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-6@test.com` });
    const { favId, poiId } = await seedFavorite({ email: `${PREFIX}9-6@test.com`, poiName: 'POI 9-6' });

    const resp = await addToTrip(favId, { tripId, dayNum: 2, startTime: '09:00', endTime: '10:30' }, { as: `${PREFIX}9-6@test.com` });
    expect(resp.status).toBe(201);

    // v2.29.0: trip_entries.{time, poi_id} DROPPED. 驗 start_time/end_time + trip_entry_pois。
    const day2 = await dayId(tripId, 2);
    const entries = await entriesOfDay(day2);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.start_time).toBe('09:00');
    expect(entries[0]!.end_time).toBe('10:30');

    const entryPois = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entries[0]!.id)
      .all<{ poi_id: number; sort_order: number }>();
    expect(entryPois.results).toEqual([{ poi_id: poiId, sort_order: 1 }]);
    // v2.29.0: trip_pois timeline rows 已不再寫 — 整表 DROPPED。

    // V2 user 路徑的 audit：trip_id 為該行程、changed_by 為 email
    const audit = await db
      .prepare(`SELECT changed_by, trip_id FROM audit_log WHERE table_name = 'trip_entries' AND record_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(entries[0]!.id)
      .first<{ changed_by: string; trip_id: string }>();
    expect(audit).toEqual({ changed_by: `${PREFIX}9-6@test.com`, trip_id: tripId });
  });

  it('別人的收藏 → 403，不建立 entry', async () => {
    const tripId = `${PREFIX}9-6-not-mine`;
    const attacker = `${PREFIX}9-6-attacker@test.com`;
    await seedAddTripFixture({ tripId, ownerEmail: attacker });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-6-victim@test.com` });

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: attacker });
    expect(resp.status).toBe(403);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });

  it('對目標行程沒有寫入權限 → 403，不建立 entry', async () => {
    const tripId = `${PREFIX}9-6-no-write`;
    await seedAddTripFixture({ tripId, ownerEmail: `${PREFIX}9-6-trip-owner@test.com` });
    const stranger = `${PREFIX}9-6-stranger@test.com`;
    const { favId } = await seedFavorite({ email: stranger });

    const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: stranger });
    expect(resp.status).toBe(403);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });

  it('收藏不存在或已軟刪除 → 404', async () => {
    const email = `${PREFIX}9-6-gone@test.com`;
    const tripId = `${PREFIX}9-6-gone`;
    await seedAddTripFixture({ tripId, ownerEmail: email });
    const { favId } = await seedFavorite({ email });
    await db.prepare("UPDATE poi_favorites SET deleted_at = '2026-04-01 10:00:00' WHERE id = ?").bind(favId).run();

    const softDeleted = await addToTrip(favId, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: email });
    expect(softDeleted.status).toBe(404);
    const missing = await addToTrip(999_999, { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00' }, { as: email });
    expect(missing.status).toBe(404);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });

  it('指定的 day 不存在 → 404', async () => {
    const email = `${PREFIX}9-6-noday@test.com`;
    const tripId = `${PREFIX}9-6-noday`;
    await seedAddTripFixture({ tripId, ownerEmail: email });
    const { favId } = await seedFavorite({ email });

    const resp = await addToTrip(favId, { tripId, dayNum: 9, startTime: '10:00', endTime: '11:00' }, { as: email });
    expect(resp.status).toBe(404);
  });

  it('第 11 次加入 → 429（add-to-trip 自己一個限流桶，不吃 POST 收藏的額度）', async () => {
    const email = `${PREFIX}9-6-rl@test.com`;
    const tripId = `${PREFIX}9-6-rl`;
    await seedAddTripFixture({ tripId, ownerEmail: email });
    const { favId } = await seedFavorite({ email });
    const bearer = await mintToken(env, { email });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const hour = String(i).padStart(2, '0');
      const resp = await addToTrip(favId, { tripId, dayNum: 1, startTime: `${hour}:00`, endTime: `${hour}:30` }, { bearer });
      statuses.push(resp.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`poi-favorites-add-to-trip:user:%${PREFIX}9-6-rl%`).run();
  });
});

// --- §9.7 companion ---

describe('POST /api/poi-favorites/:id/add-to-trip — §9.7 companion', () => {
  it('valid 三 gate + companionRequestId + ownership match → 201 + audit_log companion sentinel', async () => {
    const tripId = `${PREFIX}9-7`;
    await seedAddTripFixture({ tripId, ownerEmail: SUBMITTER_EMAIL });
    const submitterUserRow = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(SUBMITTER_EMAIL)
      .first<{ id: string }>();
    const submitterUserId = submitterUserRow!.id;
    const poiId = await seedPoi(db, { name: `${PREFIX}POI 9-7 companion` });
    const favRow = await db
      .prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?) RETURNING id')
      .bind(submitterUserId, poiId)
      .first<{ id: number }>();
    const favId = favRow!.id;
    const { requestId } = await newTripRequest();

    const resp = await addToTrip(
      favId,
      { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00', companionRequestId: requestId },
      { bearer: await companionToken(env) },
      COMPANION,
    );
    expect(resp.status).toBe(201);
    const created = await entriesOfDay(await dayId(tripId, 1));
    expect(created).toHaveLength(1);

    // companion_request_actions 1 row（action='add_to_trip'）
    const actions = await db
      .prepare('SELECT action FROM companion_request_actions WHERE request_id = ?')
      .bind(requestId)
      .all<{ action: string }>();
    expect(actions.results).toHaveLength(1);
    expect(actions.results[0]!.action).toBe('add_to_trip');

    // audit_log companion sentinel
    const audit = await db
      .prepare(
        `SELECT changed_by, trip_id FROM audit_log
         WHERE table_name = 'trip_entries' AND request_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(requestId)
      .first<{ changed_by: string; trip_id: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.changed_by).toBe(`companion:${requestId}`);
    expect(audit!.trip_id).toBe('system:companion');
  });

  it('CSO finding fix: companion 送 tripId X，submitter 沒 write to X → 403（防 prompt-injected cross-trip）', async () => {
    // Setup：submitter own 一個 trip A（用來建 trip_request）；建另一個 trip B
    // 由別人 own，submitter 無權限。Companion 嘗試把收藏加進 B → 應 403。
    const foreignTripId = `${PREFIX}foreign-${Date.now()}`;
    await seedAddTripFixture({ tripId: foreignTripId, ownerEmail: `${PREFIX}foreign-owner@test.com` });

    const submitterUserRow = await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(SUBMITTER_EMAIL)
      .first<{ id: string }>();
    const submitterUserId = submitterUserRow!.id;
    const poiId = await seedPoi(db, { name: `${PREFIX}POI cross-trip guard` });
    const favRow = await db
      .prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?) RETURNING id')
      .bind(submitterUserId, poiId)
      .first<{ id: number }>();
    const favId = favRow!.id;

    // trip_request 對應 submitter 自己的 trip（合法 context）
    const { requestId } = await newTripRequest();

    // 攻擊：body.tripId 改成 foreignTripId（submitter 沒 write 權限）
    const resp = await addToTrip(
      favId,
      { tripId: foreignTripId, dayNum: 1, startTime: '10:00', endTime: '11:00', companionRequestId: requestId },
      { bearer: await companionToken(env) },
      COMPANION,
    );
    // 預期 403 PERM_DENIED（submitter 對 foreignTripId 無寫入權限）
    expect(resp.status).toBe(403);
    expect(await entriesOfDay(await dayId(foreignTripId, 1))).toHaveLength(0);
  });

  it('companion 帶別人的收藏 → 403（ownership 以 submitter 為準），不建立 entry', async () => {
    const tripId = `${PREFIX}9-7-not-mine`;
    await seedAddTripFixture({ tripId, ownerEmail: SUBMITTER_EMAIL });
    const { favId } = await seedFavorite({ email: `${PREFIX}9-7-victim@test.com` });
    const { requestId } = await newTripRequest();

    const resp = await addToTrip(
      favId,
      { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00', companionRequestId: requestId },
      { bearer: await companionToken(env) },
      COMPANION,
    );
    expect(resp.status).toBe(403);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });

  it('companion gate 失敗（缺 scope／clientId 不對）→ 401，不建立 entry', async () => {
    const tripId = `${PREFIX}9-7-gate`;
    await seedAddTripFixture({ tripId, ownerEmail: SUBMITTER_EMAIL });
    const submitterUserId = (await db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
      .bind(SUBMITTER_EMAIL)
      .first<{ id: string }>())!.id;
    const poiId = await seedPoi(db, { name: `${PREFIX}POI 9-7 gate` });
    const fav = await db
      .prepare('INSERT INTO poi_favorites (user_id, poi_id) VALUES (?, ?) RETURNING id')
      .bind(submitterUserId, poiId)
      .first<{ id: number }>();
    const { requestId } = await newTripRequest();
    const body = { tripId, dayNum: 1, startTime: '10:00', endTime: '11:00', companionRequestId: requestId };

    const noScope = await addToTrip(fav!.id, body, { bearer: await companionToken(env, { scopes: ['admin'] }) }, COMPANION);
    expect(noScope.status).toBe(401);
    const wrongClient = await addToTrip(fav!.id, body, { bearer: await companionToken(env, { clientId: 'rogue-cli' }) }, COMPANION);
    expect(wrongClient.status).toBe(401);
    expect(await entriesOfDay(await dayId(tripId, 1))).toHaveLength(0);
  });
});
