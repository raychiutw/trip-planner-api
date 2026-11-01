/**
 * API Test Helpers — 共用 mock 建構工具
 */
import type { Env, AuthData } from '../../src/env';

/** 建立 mock Env 物件 */
export function mockEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    CF_API_TOKEN: 'test-token',
    CF_ACCOUNT_ID: 'test-account',
    CF_ACCESS_APP_ID: 'test-app',
    CF_ACCESS_POLICY_ID: 'test-policy',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ...overrides,
  } as Env;
}

/** Synthetic userId from email: 'a@b.com' → 'test-user-a-b-com' */
export function userIdFor(email: string): string {
  return `test-user-${email.replace(/[^a-z0-9]/gi, '-')}`;
}

/** Insert users row (idempotent). Tests that create trips/permissions/saved-pois need user FK satisfied. */
export async function seedUser(db: D1Database, email = 'user@test.com'): Promise<string> {
  const id = userIdFor(email);
  await db.prepare(
    'INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)'
  ).bind(id, email, email.split('@')[0]).run();
  return id;
}

/** 建立 mock auth context。V2 cutover：userId 從 email 衍生，呼叫端應先 seedUser(email)。 */
export function mockAuth(overrides: Partial<AuthData> = {}): AuthData {
  const email = overrides.email ?? 'user@test.com';
  return {
    email,
    userId: overrides.userId ?? userIdFor(email),
    isServiceToken: false,
    ...overrides,
  };
}

/**
 * 建立 service-token mock auth（Phase 3：維運 / companion 身份，user_id=null）。
 * 預設帶 companion scope — PATCH /api/requests/:id 的 gate（companion service token
 * 或對該 trip 有寫權的 user，v2.55.56）需要。維運 ops 端點測試覆寫 scopes（如 ['ops:maps']）。
 */
export function mockServiceAuth(overrides: Partial<AuthData> = {}): AuthData {
  return {
    email: overrides.email ?? 'service:cli-test',
    userId: null,
    isServiceToken: true,
    scopes: overrides.scopes ?? ['companion'],
    ...overrides,
  };
}

/** 插入測試行程 + 天 + 權限。
 *  V2 cutover (migration 0047): trips.owner / trip_permissions.email columns dropped。
 *  helper 自動 INSERT users row + 用 user_id-keyed schema。 */
export async function seedTrip(db: D1Database, opts: {
  id?: string;
  owner?: string;
  days?: number;
  published?: number;
} = {}) {
  const id = opts.id || 'test-trip';
  const ownerEmail = opts.owner || 'user@test.com';
  const days = opts.days || 3;
  const published = opts.published ?? 1;
  const ownerUserId = `test-user-${ownerEmail.replace(/[^a-z0-9]/gi, '-')}`;

  await db.prepare(
    'INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)'
  ).bind(ownerUserId, ownerEmail, ownerEmail.split('@')[0]).run();

  await db.prepare(
    'INSERT OR IGNORE INTO trips (id, name, owner_user_id, title, countries, published) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, id, ownerUserId, `Test Trip ${id}`, 'JP', published).run();

  for (let i = 1; i <= days; i++) {
    await db.prepare(
      'INSERT OR IGNORE INTO trip_days (trip_id, day_num, date, day_of_week, label) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, i, `2026-04-0${i}`, '月', `Day ${i}`).run();
  }

  await db.prepare(
    'INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, ?)'
  ).bind(ownerUserId, id, 'owner').run();

  return { id, owner: ownerEmail, ownerUserId };
}

/** 插入測試 entry。
 *  v2.29.0: trip_entries.{time, travel_*, poi_id} DROPPED。
 *  Spatial / master POI 走 trip_entry_pois (caller 自行 INSERT)。
 *  poi_id opt 已 deprecated；若 caller 仍傳，會自動 INSERT trip_entry_pois sort_order=1。
 */
export async function seedEntry(db: D1Database, dayId: number, opts: {
  sortOrder?: number;
  /** @deprecated v2.29.0 — pass through trip_entry_pois INSERT instead */
  poiId?: number | null;
} = {}) {
  const result = await db.prepare(
    `INSERT INTO trip_entries (day_id, sort_order, start_time)
     VALUES (?, ?, ?) RETURNING id`,
  ).bind(
    dayId,
    opts.sortOrder ?? 1,
    '10:00',
  ).first<{ id: number }>();
  const entryId = result!.id;
  // Backward-compat: poiId opt → INSERT trip_entry_pois.sort_order=1 (master)
  if (opts.poiId != null) {
    await db.prepare(
      `INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)`,
    ).bind(entryId, opts.poiId).run();
  }
  return entryId;
}

/** 插入測試 POI */
export async function seedPoi(db: D1Database, opts: {
  type?: string;
  name?: string;
} = {}) {
  const result = await db.prepare(
    'INSERT INTO pois (type, name) VALUES (?, ?) RETURNING id'
  ).bind(opts.type || 'restaurant', opts.name || 'Test POI').first<{ id: number }>();
  return result!.id;
}

/** 取得 trip_days 的 id */
export async function getDayId(db: D1Database, tripId: string, dayNum: number): Promise<number> {
  const row = await db.prepare(
    'SELECT id FROM trip_days WHERE trip_id = ? AND day_num = ?'
  ).bind(tripId, dayNum).first<{ id: number }>();
  return row!.id;
}

/** v2.29.0: trip_pois 整表 DROPPED. seedTripPoi removed.
 *  - hotel: 設 trip_days.hotel_poi_id (UPDATE)
 *  - shopping / entry-level POI: INSERT trip_entry_pois (sort_order > 1)
 */
export async function seedHotelForDay(db: D1Database, dayId: number, poiId: number): Promise<void> {
  await db.prepare('UPDATE trip_days SET hotel_poi_id = ? WHERE id = ?').bind(poiId, dayId).run();
}

export async function seedEntryAlternate(db: D1Database, opts: {
  entryId: number;
  poiId: number;
  sortOrder?: number;
}): Promise<number> {
  const sortOrder = opts.sortOrder ?? 2;
  const result = await db.prepare(
    `INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, ?) RETURNING id`,
  ).bind(opts.entryId, opts.poiId, sortOrder).first<{ id: number }>();
  return result!.id;
}
