import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser, userIdFor } from './helpers';
import { createApi } from './http';
import { cleanupImportedTrips } from './cleanup-imported';

// 走 HTTP 邊界（tests/api/http.ts）。故障注入（failStatements）是 env 層級的基礎設施故障，不是檢查 SQL 形狀。
let db: D1Database;
const email = 'trip-creation@test.com';

beforeAll(async () => { db = await createTestDb(); await seedUser(db, email); });
afterAll(async () => {
  await cleanupImportedTrips(db, email, ['大型匯入%', '匯入故障%', '匯入補償%', '匯入受限%', '匯入共用 POI%', '同名匯入%']);
  await disposeMiniflare();
});

function payload(name: string, count = 60) {
  return {
    schemaVersion: 1,
    meta: { name, title: name, countries: 'JP', destinations: [{ name: '沖繩', dayQuota: 2 }] },
    days: [0, 1].map((day) => ({
      dayNum: day + 1, date: `2026-09-${day + 20}`, dayOfWeek: '日', label: `第 ${day + 1} 天`,
      hotel: { name: `${name}飯店${day}`, type: 'hotel' },
      timeline: Array.from({ length: count / 2 }, (_, i) => ({
        sortOrder: i + 1,
        stopPois: [
          { sortOrder: 1, name: `${name}正選${day}-${i}`, type: 'attraction', note: '正選備註', reservation: '已預訂' },
          { sortOrder: 2, name: `${name}備選${day}-${i}`, type: 'restaurant', note: '備選備註' },
        ],
      })),
    })),
    segments: [{ fromEntryIdx: 0, toEntryIdx: 1, mode: 'walking', min: 5 }, { fromEntryIdx: count / 2, toEntryIdx: count / 2 + 1, mode: 'walking', min: 6 }],
    notes: {
      flights: [{ airline: '航司', flightNo: 'AB123' }],
      lodgings: [{ name: '住宿筆記' }],
      reservations: [{ kind: 'restaurant', title: '晚餐' }],
      pretripNotes: [{ section: 'general', title: '提醒', content: '帶護照' }],
      emergencyContacts: [{ name: '聯絡人', kind: 'personal' }],
    },
  };
}

function failStatements(patterns: RegExp[]): D1Database {
  return new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => {
      const hit = patterns.find((pattern) => pattern.test(sql));
      if (hit) {
        patterns.splice(patterns.indexOf(hit), 1);
        const failure = target.prepare('SELECT json(?)').bind('injected-invalid-json');
        return new Proxy(failure, { get(stmt, member) {
          if (member === 'bind') return () => failure;
          const value = Reflect.get(stmt, member);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      }
      return target.prepare(sql);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function importTrip(body: unknown, requestDb = db) {
  return createApi({ env: mockEnv(requestDb) }).request('POST', '/api/trips/import', { as: email, json: body });
}

it('匯入 60 個 entry 後，多日、住宿、正選備選與 segment 均指向新行程', async () => {
  const response = await importTrip(payload('大型匯入成功'));
  expect(response.status).toBe(201);
  const { tripId } = await response.json() as { tripId: string };
  const counts = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM trip_days WHERE trip_id = ?) AS days,
    (SELECT COUNT(*) FROM trip_entries e JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ?) AS entries,
    (SELECT COUNT(*) FROM trip_entry_pois ep JOIN trip_entries e ON e.id = ep.entry_id JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ?) AS pois,
    (SELECT COUNT(*) FROM trip_segments WHERE trip_id = ?) AS segments,
    (SELECT COUNT(*) FROM trip_days WHERE trip_id = ? AND hotel_poi_id IS NOT NULL) AS hotels`
  ).bind(tripId, tripId, tripId, tripId, tripId).first<{ days: number; entries: number; pois: number; segments: number; hotels: number }>();
  expect(counts).toEqual({ days: 2, entries: 60, pois: 120, segments: 2, hotels: 2 });
  const meta = await db.prepare('SELECT owner_user_id, name, title, published, data_source, lang FROM trips WHERE id = ?')
    .bind(tripId).first<Record<string, unknown>>();
  expect(meta).toMatchObject({ owner_user_id: userIdFor(email), name: '大型匯入成功', title: '大型匯入成功', published: 0, data_source: 'imported', lang: 'zh-TW' });
  const owner = await db.prepare('SELECT role FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
    .bind(tripId, userIdFor(email)).first<{ role: string }>();
  expect(owner?.role).toBe('owner');
  const destination = await db.prepare('SELECT name, day_quota FROM trip_destinations WHERE trip_id = ?')
    .bind(tripId).first<{ name: string; day_quota: number }>();
  expect(destination).toEqual({ name: '沖繩', day_quota: 2 });
  const content = await db.prepare(`SELECT ep.sort_order, ep.note, ep.reservation, e.entry_pois_version
    FROM trip_entry_pois ep JOIN trip_entries e ON e.id = ep.entry_id JOIN trip_days d ON d.id = e.day_id
    WHERE d.trip_id = ? AND d.day_num = 1 AND e.sort_order = 1 ORDER BY ep.sort_order`)
    .bind(tripId).all<{ sort_order: number; note: string; reservation: string | null; entry_pois_version: number }>();
  expect(content.results).toEqual([
    { sort_order: 1, note: '正選備註', reservation: '已預訂', entry_pois_version: 1 },
    { sort_order: 2, note: '備選備註', reservation: null, entry_pois_version: 1 },
  ]);
  const notes = await db.prepare('SELECT content FROM trip_pretrip_notes WHERE trip_id = ?').bind(tripId).all<{ content: string }>();
  expect(notes.results).toEqual([{ content: '帶護照' }]);
  for (const table of ['trip_flights', 'trip_lodgings', 'trip_reservations', 'trip_emergency_contacts']) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE trip_id = ?`).bind(tripId).first<{ n: number }>();
    expect(row?.n).toBe(1);
  }
  const links = await db.prepare(`SELECT d.day_num AS from_day, d2.day_num AS to_day
    FROM trip_segments s JOIN trip_entries e ON e.id = s.from_entry_id JOIN trip_days d ON d.id = e.day_id
    JOIN trip_entries e2 ON e2.id = s.to_entry_id JOIN trip_days d2 ON d2.id = e2.day_id
    WHERE s.trip_id = ? ORDER BY d.day_num`).bind(tripId).all<{ from_day: number; to_day: number }>();
  expect(links.results).toEqual([{ from_day: 1, to_day: 1 }, { from_day: 2, to_day: 2 }]);
  const audit = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE trip_id = ? AND action = 'insert'").bind(tripId).first<{ n: number }>();
  expect(audit?.n).toBe(60);
});

it.each([
  ['day', /INSERT INTO trip_days/],
  ['entry', /INSERT INTO trip_entries/],
  ['junction', /INSERT INTO trip_entry_pois/],
  ['hotel', /UPDATE trip_days SET hotel_poi_id/],
  ['segment', /INSERT INTO trip_segments/],
] as const)('%s 必要寫入故障回失敗，且不殘留新行程結構', async (phase, sql) => {
  const body = payload(`匯入故障 ${phase}`, 2);
  const response = await importTrip(body, failStatements([sql]));
  expect(response.status).toBeGreaterThanOrEqual(500);
  const trip = await db.prepare('SELECT id FROM trips WHERE name = ?').bind(body.meta.name).first();
  expect(trip).toBeNull();
  const pois = await db.prepare('SELECT COUNT(*) AS n FROM pois WHERE name LIKE ?').bind(`${body.meta.name}%`).first<{ n: number }>();
  expect(pois?.n).toBe(0);
});

it('超過 50 筆 entry 已提交後 segment 失敗，補償清除本次行程並允許重試', async () => {
  const body = payload('大型匯入後段故障');
  const auditsBefore = await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE changed_by = ?').bind(email).first<{ n: number }>();
  const failed = await importTrip(body, failStatements([/INSERT INTO trip_segments/]));
  expect(failed.status).toBeGreaterThanOrEqual(500);
  const left = await db.prepare('SELECT COUNT(*) AS n FROM trips WHERE name = ?').bind(body.meta.name).first<{ n: number }>();
  expect(left?.n).toBe(0);
  const auditsAfter = await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE changed_by = ?').bind(email).first<{ n: number }>();
  expect(auditsAfter?.n).toBe(auditsBefore?.n);
  expect((await importTrip(body)).status).toBe(201);
});

it('建立及補償都失敗時，回應能辨識清理未完成', async () => {
  const body = payload('匯入補償故障', 2);
  // 行為變更：新 api 對 5xx 一律不回 detail（只回通用訊息），「清理失敗」改為只進伺服器 log（AppError.detail），
  // 回應只剩 code=SYS_DB_ERROR。舊入口會把 detail 放進回應。
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await importTrip(body, failStatements([/INSERT INTO trip_segments/, /DELETE FROM trips WHERE id/]));
    expect(response.status).toBeGreaterThanOrEqual(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SYS_DB_ERROR' } });
    expect(logged.mock.calls.flat().some((a) => String(a).includes('清理失敗'))).toBe(true);
  } finally {
    logged.mockRestore();
  }
});

it('失敗補償保留原有共用 POI；fill-null 補入的空欄仍保留', async () => {
  const body = payload('匯入共用 POI 補償', 2);
  const name = `${body.meta.name}正選0-0`;
  const original = await db.prepare("INSERT INTO pois (type, name, address, rating) VALUES ('attraction', ?, NULL, 4.5) RETURNING id")
    .bind(name).first<{ id: number }>();
  Object.assign(body.days[0]!.timeline[0]!.stopPois[0]!, { address: '新補地址', rating: 1 });
  expect((await importTrip(body, failStatements([/INSERT INTO trip_segments/]))).status).toBeGreaterThanOrEqual(500);
  const row = await db.prepare('SELECT id, address, rating FROM pois WHERE id = ?').bind(original!.id)
    .first<{ id: number; address: string; rating: number }>();
  expect(row).toEqual({ id: original!.id, address: '新補地址', rating: 4.5 });
});

it('匯入入口拒絕無效資料，重複匯入同名行程仍建立各自的 ID', async () => {
  expect((await importTrip({ schemaVersion: 1, meta: {}, days: [] })).status).toBe(400);
  const body = payload('同名匯入', 2);
  const first = await importTrip(body);
  const second = await importTrip(body);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstId = (await first.json() as { tripId: string }).tripId;
  const secondId = (await second.json() as { tripId: string }).tripId;
  expect(firstId).not.toBe(secondId);
});

it('受限 token（restrict_trip）不可匯入新行程，也不建立任何資料', async () => {
  const body = payload('匯入受限 token', 2);
  const response = await createApi({ env: mockEnv(db) })
    .request('POST', '/api/trips/import', { as: email, restrictTrip: 'some-other-trip', json: body });
  expect(response.status).toBe(403);
  const trip = await db.prepare('SELECT id FROM trips WHERE name = ?').bind(body.meta.name).first();
  expect(trip).toBeNull();
});
