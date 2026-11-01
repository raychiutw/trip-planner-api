/**
 * #1259 — 整日重寫 PUT 走 entry intake 批次入口的特徵測試（migration 前後皆須綠）：
 * name fallback（含 entry-level note）、stopPois 正選+備選、無 POI 佔位 entry 三種同時存在。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser, seedTrip, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const owner = 'put-day-intake@test.com';
const tripId = 'trip-put-day-intake';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedUser(db, owner);
  await seedTrip(db, { id: tripId, owner, days: 1 });
});
afterAll(async () => {
  // 共用 D1：只清自己建立的行程（trip_permissions 無 FK cascade）
  await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(tripId).run();
  await db.prepare('DELETE FROM trips WHERE id = ?').bind(tripId).run();
  await disposeMiniflare();
});

describe('PUT /api/trips/:id/days/:num → entry intake 批次入口', () => {
  it('三種 entry 形態一次寫入：version / 正選 note / 備選 / sort_order 全對', async () => {
    const dayId = await getDayId(db, tripId, 1);
    const resp = await api.request('PUT', `/api/trips/${tripId}/days/1`, { as: owner, json: {
        date: '2026-09-05', dayOfWeek: '六', label: 'D1',
        timeline: [
          { name: 'PUT 名稱景點', poi_type: 'attraction', note: '整體備註', time: '09:00' },
          { time: '11:00', stopPois: [
            { name: 'PUT 正選', type: 'restaurant', note: '正選備註' },
            { name: 'PUT 備選', type: 'restaurant', note: '備選備註' },
          ] },
          { description: '純佔位', time: '13:00' },
        ],
    } });
    expect(resp.status).toBe(200);
    const entries = await db.prepare('SELECT id, sort_order, entry_pois_version, description FROM trip_entries WHERE day_id = ? ORDER BY sort_order').bind(dayId).all<{ id: number; sort_order: number; entry_pois_version: number; description: string | null }>();
    expect(entries.results.map((e) => [e.sort_order, e.entry_pois_version])).toEqual([[0, 1], [1, 1], [2, 0]]);
    const [a, b, c] = entries.results;
    const aPois = await db.prepare('SELECT p.name, tep.sort_order, tep.note FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id WHERE tep.entry_id = ? ORDER BY tep.sort_order').bind(a!.id).all<{ name: string; sort_order: number; note: string | null }>();
    expect(aPois.results).toEqual([{ name: 'PUT 名稱景點', sort_order: 1, note: '整體備註' }]);
    const bPois = await db.prepare('SELECT p.name, tep.sort_order, tep.note FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id WHERE tep.entry_id = ? ORDER BY tep.sort_order').bind(b!.id).all<{ name: string; sort_order: number; note: string | null }>();
    expect(bPois.results).toEqual([
      { name: 'PUT 正選', sort_order: 1, note: '正選備註' },
      { name: 'PUT 備選', sort_order: 2, note: '備選備註' },
    ]);
    const cPois = await db.prepare('SELECT COUNT(*) AS n FROM trip_entry_pois WHERE entry_id = ?').bind(c!.id).first<{ n: number }>();
    expect(cPois!.n).toBe(0);
    expect(c!.description).toBe('純佔位');
    const day = await db.prepare('SELECT version FROM trip_days WHERE id = ?').bind(dayId).first<{ version: number }>();
    expect(day!.version).toBe(1);
  });

  it('正選自己沒 note → 繼承 entry 層級 note；備選維持各自 note', async () => {
    const dayId = await getDayId(db, tripId, 1);
    const resp = await api.request('PUT', `/api/trips/${tripId}/days/1`, { as: owner, json: {
      date: '2026-09-05', dayOfWeek: '六', label: 'D1',
      timeline: [
        { time: '09:00', note: '繼承用備註', stopPois: [
          { name: 'PUT 繼承正選', type: 'restaurant' },
          { name: 'PUT 繼承備選', type: 'restaurant', note: '備選自己的備註' },
        ] },
      ],
    } });
    expect(resp.status).toBe(200);
    const entry = await db.prepare('SELECT id FROM trip_entries WHERE day_id = ?').bind(dayId).first<{ id: number }>();
    const pois = await db.prepare('SELECT p.name, tep.sort_order, tep.note FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id WHERE tep.entry_id = ? ORDER BY tep.sort_order').bind(entry!.id).all<{ name: string; sort_order: number; note: string | null }>();
    expect(pois.results).toEqual([
      { name: 'PUT 繼承正選', sort_order: 1, note: '繼承用備註' },
      { name: 'PUT 繼承備選', sort_order: 2, note: '備選自己的備註' },
    ]);
  });
});
