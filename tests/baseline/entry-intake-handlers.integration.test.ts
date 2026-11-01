/**
 * #1257 — 兩條已改接 entry intake 的路徑，各留一個 handler 層接線 case：
 * 走 onRequestPost 進、從 DB 驗「不變量真的套到了」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser, seedTrip, seedPoi, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const owner = 'intake-handlers@test.com';
const tripId = 'trip-intake-handlers';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedUser(db, owner);
  await seedTrip(db, { id: tripId, owner, days: 1 });
});
afterAll(async () => {
  // 共用 D1：只清自己建立的資料（trip_permissions 與 poi_favorites 無 FK cascade 到 trips）
  const userId = await seedUser(db, owner);
  await db.prepare('DELETE FROM poi_favorites WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(tripId).run();
  await db.prepare('DELETE FROM trips WHERE id = ?').bind(tripId).run();
  await disposeMiniflare();
});

describe('POST /api/trips/:id/days/:num/entries → entry intake', () => {
  it('body.source 進 pois.source 與 trip_entries.source；note 進正選；version=1；audit 存在', async () => {
    const resp = await api.request('POST', `/api/trips/${tripId}/days/1/entries`, { as: owner, json: {
      name: '接線景點', poi_type: 'attraction', lat: 26.2, lng: 127.7, source: 'custom', note: '  單筆備註  ', start_time: '09:00', end_time: '10:00',
    } });
    expect(resp.status).toBe(201);
    const row = await resp.json() as { id: number; source: string; entryPoisVersion: number };
    expect(row.source).toBe('custom');
    expect(row.entryPoisVersion).toBe(1);
    const master = await db.prepare(
      'SELECT tep.note, p.source FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id WHERE tep.entry_id = ? AND tep.sort_order = 1',
    ).bind(row.id).first<{ note: string; source: string }>();
    expect(master).toEqual({ note: '單筆備註', source: 'custom' });
    const audit = await db.prepare("SELECT diff_json FROM audit_log WHERE table_name = 'trip_entries' AND record_id = ? AND action = 'insert'").bind(row.id).first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ day_num: 1, poiName: '接線景點' });
  });
});

describe('POST /api/trips/:id/entries/:eid/copy → entry intake 批次入口（#1258）', () => {
  it('正選 + 備選連同各自 note / reservation 一起複製；version=1；audit 存在', async () => {
    const dayId = await getDayId(db, tripId, 1);
    const master = await seedPoi(db, { name: '複製 正選', type: 'attraction' });
    const alt = await seedPoi(db, { name: '複製 備選', type: 'restaurant' });
    const srcId = await seedEntry(db, dayId, { poiId: master });
    await db.prepare('UPDATE trip_entry_pois SET note = ? WHERE entry_id = ? AND sort_order = 1').bind('正選備註', srcId).run();
    await db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, note, reservation) VALUES (?, ?, 2, ?, ?)').bind(srcId, alt, '備選備註', '已訂').run();
    const resp = await api.request('POST', `/api/trips/${tripId}/entries/${srcId}/copy`, { as: owner, json: { targetDayId: dayId } });
    expect(resp.status).toBe(200);
    const row = await resp.json() as { id: number; entryPoisVersion: number };
    expect(row.entryPoisVersion).toBe(1);
    const pois = await db.prepare('SELECT poi_id, sort_order, note, reservation FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order').bind(row.id).all<{ poi_id: number; sort_order: number; note: string | null; reservation: string | null }>();
    expect(pois.results).toEqual([
      { poi_id: master, sort_order: 1, note: '正選備註', reservation: null },
      { poi_id: alt, sort_order: 2, note: '備選備註', reservation: '已訂' },
    ]);
    const audit = await db.prepare("SELECT diff_json FROM audit_log WHERE table_name = 'trip_entries' AND record_id = ? AND action = 'insert'").bind(row.id).first<{ diff_json: string }>();
    expect(JSON.parse(audit!.diff_json)).toMatchObject({ copiedFromEntryId: srcId });
  });
});
