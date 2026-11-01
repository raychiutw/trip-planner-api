/**
 * Integration test — v2.10 Wave 1: Item 2 copy + Item 3 move（跨天）
 *
 * Item 2: POST /api/trips/:id/entries/:eid/copy
 * Item 3: PATCH /api/trips/:id/entries/:eid（day_id 加進 ALLOWED_FIELDS）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, seedPoi, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
const OWNER = 'entry-copy-move-owner@test.com';
// 匿名的瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 handler 的 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
const tripIds: string[] = [];
/** 建立行程並記下 id，afterAll 清掉（共用 D1）。 */
const seed = async (opts: { id: string; days?: number }) => {
  tripIds.push(opts.id);
  return seedTrip(db, { owner: OWNER, ...opts });
};
const copy = (eid: number, json: unknown, as: string | null = OWNER) =>
  api.request('POST', `/api/trips/s8-cm/entries/${eid}/copy`, {
    as: as ?? undefined,
    json,
    headers: as ? undefined : { Origin: BROWSER_ORIGIN },
  });
const patch = (eid: number, json: unknown) =>
  api.request('PATCH', `/api/trips/s8-cm/entries/${eid}`, { as: OWNER, json });
let day1Id: number;
let day2Id: number;
let day3Id: number;
let entryDay1Id: number;
let masterPoiDay1Id: number;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: BROWSER_ORIGIN }) });
  await seed({ id: 's8-cm', days: 3 });
  // Seed second trip for cross-trip protection tests
  await seed({ id: 's8-cm-other', days: 2 });
  day1Id = await getDayId(db, 's8-cm', 1);
  day2Id = await getDayId(db, 's8-cm', 2);
  day3Id = await getDayId(db, 's8-cm', 3);
  // v2.29.0: trip_entries.time DROPPED；用 start_time/end_time 直接 UPDATE。
  // migration 0078: trip_entries.note DROPPED — 備註改掛 master trip_entry_pois.note。
  masterPoiDay1Id = await seedPoi(db, { name: '美ら海水族館', type: 'attraction' });
  entryDay1Id = await seedEntry(db, day1Id, { poiId: masterPoiDay1Id });
  await db.prepare('UPDATE trip_entries SET start_time = ?, end_time = ? WHERE id = ?')
    .bind('11:30', '14:00', entryDay1Id).run();
  // master poi 的 per-POI note（copy 時應隨 trip_entry_pois 複製過去）
  await db.prepare('UPDATE trip_entry_pois SET note = ? WHERE entry_id = ? AND sort_order = 1')
    .bind('mock note', entryDay1Id).run();
});

afterAll(async () => {
  // 共用 D1：只清自己建立的行程（days / entries 等子表走 FK cascade，permissions 要手動清）
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

describe('POST /api/trips/:id/entries/:eid/copy — Item 2', () => {
  it('同日複製可指定新時段，來源時間不變', async () => {
    const resp = await copy(entryDay1Id, { targetDayId: day1Id, time: '09:00 - 11:30' });
    expect(resp.status).toBe(200);
    const copied = await resp.json() as { id: number };
    const rows = await db.prepare('SELECT id, day_id, start_time, end_time FROM trip_entries WHERE id IN (?, ?) ORDER BY id')
      .bind(entryDay1Id, copied.id).all<{ id: number; day_id: number; start_time: string; end_time: string }>();
    expect(rows.results).toEqual([
      { id: entryDay1Id, day_id: day1Id, start_time: '11:30', end_time: '14:00' },
      { id: copied.id, day_id: day1Id, start_time: '09:00', end_time: '11:30' },
    ]);
  });

  it('複製 entry 到目標 day → 200 + 新 row + 原 entry 仍存在', async () => {
    const resp = await copy(entryDay1Id, { targetDayId: day2Id });
    expect(resp.status).toBe(200);
    const newRow = await resp.json() as Record<string, unknown>;
    // json() helper deep-camels keys: day_id → dayId, sort_order → sortOrder
    expect(newRow.dayId).toBe(day2Id);
    expect(Object.prototype.hasOwnProperty.call(newRow, 'title')).toBe(false);
    // v2.29.0: trip_entries.time DROPPED — 改驗 start_time / end_time
    expect(newRow.startTime).toBe('11:30');
    expect(newRow.endTime).toBe('14:00');
    expect(newRow.id).not.toBe(entryDay1Id);

    // migration 0078: entry-level note 已 DROP；per-POI note 隨 master trip_entry_pois 複製。
    const copiedMaster = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(newRow.id)
      .first<{ note: string | null }>();
    expect(copiedMaster!.note).toBe('mock note');

    // 原 entry 仍存在（copy 不是 move）
    const orig = await db.prepare('SELECT * FROM trip_entries WHERE id = ?').bind(entryDay1Id).first();
    expect(orig).toBeTruthy();

    // audit log 寫入 — action='insert' + diff 含 source ref
    const audit = await db.prepare("SELECT * FROM audit_log WHERE table_name='trip_entries' AND action='insert' AND record_id=?")
      .bind(newRow.id).first() as Record<string, unknown> | null;
    expect(audit).toBeTruthy();
    expect(audit?.diff_json as string).toContain('copiedFromEntryId');
  });

  it('targetDayId 屬於別 trip → 403', async () => {
    const otherDayId = await getDayId(db, 's8-cm-other', 1);
    expect((await copy(entryDay1Id, { targetDayId: otherDayId })).status).toBe(403);
  });

  it('無 trip 寫入權限 → 403，不產生新 entry', async () => {
    const countBefore = (await db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE day_id = ?').bind(day2Id).first<{ n: number }>())!.n;
    expect((await copy(entryDay1Id, { targetDayId: day2Id }, 'entry-copy-move-stranger@test.com')).status).toBe(403);
    const countAfter = (await db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE day_id = ?').bind(day2Id).first<{ n: number }>())!.n;
    expect(countAfter).toBe(countBefore);
  });

  it('entry 不屬於路徑上的 trip → 404，不產生新 entry', async () => {
    const otherDayId = await getDayId(db, 's8-cm-other', 1);
    const otherEntry = await seedEntry(db, otherDayId);
    const countBefore = (await db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE day_id = ?').bind(day2Id).first<{ n: number }>())!.n;
    expect((await copy(otherEntry, { targetDayId: day2Id })).status).toBe(404);
    const countAfter = (await db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE day_id = ?').bind(day2Id).first<{ n: number }>())!.n;
    expect(countAfter).toBe(countBefore);
  });

  it('targetDayId 不存在 → 404', async () => {
    expect((await copy(entryDay1Id, { targetDayId: 99999 })).status).toBe(404);
  });

  it('未認證 → 401', async () => {
    expect((await copy(entryDay1Id, { targetDayId: day2Id }, null)).status).toBe(401);
  });

  it('targetDayId 非 number → 400', async () => {
    expect((await copy(entryDay1Id, { targetDayId: 'abc' })).status).toBe(400);
  });

  it('sortOrder 不指定 → 自動追加到目標 day 末尾', async () => {
    // 在 day3 已有一筆 entry
    const existingEid = await seedEntry(db, day3Id, { sortOrder: 0 });
    const resp = await copy(entryDay1Id, { targetDayId: day3Id });
    expect(resp.status).toBe(200);
    const newRow = await resp.json() as Record<string, unknown>;
    expect(newRow.sortOrder).toBe(1); // existingEid sortOrder 0 → new 1
    // cleanup
    await db.prepare('DELETE FROM trip_entries WHERE id IN (?, ?)').bind(existingEid, newRow.id).run();
  });
});

describe('PATCH /api/trips/:id/entries/:eid — Item 3 move 跨天 via day_id', () => {
  let movableEid: number;
  beforeAll(async () => {
    movableEid = await seedEntry(db, day1Id);
  });

  it('PATCH day_id → entry 搬到目標 day → 200', async () => {
    const resp = await patch(movableEid, { day_id: day2Id });
    expect(resp.status).toBe(200);
    const row = await db.prepare('SELECT day_id FROM trip_entries WHERE id = ?').bind(movableEid).first() as Record<string, unknown>;
    expect(row.day_id).toBe(day2Id);
  });

  it('跨日移動與新時段一起持久化', async () => {
    const entryId = await seedEntry(db, day1Id);
    expect((await patch(entryId, { day_id: day3Id, start_time: '18:00', end_time: '20:00' })).status).toBe(200);
    const row = await db.prepare('SELECT day_id, start_time, end_time FROM trip_entries WHERE id = ?').bind(entryId).first();
    expect(row).toEqual({ day_id: day3Id, start_time: '18:00', end_time: '20:00' });
  });

  it('PATCH day_id 屬於別 trip → 403', async () => {
    const otherDayId = await getDayId(db, 's8-cm-other', 1);
    expect((await patch(movableEid, { day_id: otherDayId })).status).toBe(403);
  });

  it('PATCH day_id 不存在 → 404', async () => {
    expect((await patch(movableEid, { day_id: 99999 })).status).toBe(404);
  });

  it('PATCH day_id 非 integer → 400', async () => {
    expect((await patch(movableEid, { day_id: 'abc' })).status).toBe(400);
  });
});
