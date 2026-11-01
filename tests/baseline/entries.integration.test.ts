/**
 * Integration test — PATCH/DELETE /api/trips/:id/entries/:eid
 * 走 HTTP 邊界（tests/api/http.ts），不直接呼叫 handler。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, seedPoi, getDayId } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
let entryId: number;
const OWNER = 'entries-owner@test.com';
const STRANGER = 'entries-stranger@test.com';
// 匿名的瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 handler 的 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
const tripIds: string[] = [];
/** 建立行程並記下 id，afterAll 清掉（共用 D1）。 */
const seed = async (opts: { id: string; days?: number; published?: number }) => {
  tripIds.push(opts.id);
  return seedTrip(db, { owner: OWNER, ...opts });
};
const patchEntry = (tripId: string, eid: number | string, json: unknown) =>
  api.request('PATCH', `/api/trips/${tripId}/entries/${eid}`, { as: OWNER, json });
const readTimes = (eid: number) =>
  db.prepare('SELECT start_time, end_time FROM trip_entries WHERE id = ?').bind(eid).first<{ start_time: string | null; end_time: string | null }>();

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: BROWSER_ORIGIN }) });
  await seed({ id: 's8-entries-e' });
  const dayId = await getDayId(db, 's8-entries-e', 1);
  const poiId = await seedPoi(db, { name: 'Original POI', type: 'attraction' });
  // v2.29.0: seedEntry poiId 已自動 INSERT trip_entry_pois sort_order=1（backward-compat）
  entryId = await seedEntry(db, dayId, { poiId });
});

afterAll(async () => {
  // 共用 D1：只清自己建立的行程（days / entries 等子表走 FK cascade，permissions 要手動清）
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

describe('GET /api/trips/:id/entries/:eid', () => {
  it('回完整 entry shape（含 time/master/stopPois/entry_pois_version）→ 200', async () => {
    // v2.27.1 regression：v2.26.0 SELECT 只有 id/day_id/title，導致 EditEntryPage
    // 初始 load 後 entry.startTime/endTime/master 全 undefined → input 空白。
    // Backend SELECT 改 SELECT * 一勞永逸；此 test 鎖住完整 shape 防 regression。
    // migration 0078: entry-level note 已 DROP；「正選備註」改由 master.note 提供。
    const resp = await api.get(`/api/trips/s8-entries-e/entries/${entryId}`, { as: OWNER });
    expect(resp.status).toBe(200);
    // json() helper does deepCamel — server SELECT day_id 出去變 dayId。
    const body = await resp.json() as {
      id: number | bigint;
      dayId: number | bigint;
      startTime?: string | null;
      endTime?: string | null;
      master?: { poiId: number; name: string; note?: string | null } | null;
      stopPois?: Array<{ poiId: number; sortOrder: number }>;
      alternates?: Array<{ poiId: number; sortOrder: number }>;
      entryPoisVersion?: number | string | null;
      sortOrder?: number;
    };
    expect(Number(body.id)).toBe(Number(entryId));
    expect(Number(body.dayId)).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(body as Record<string, unknown>, 'title')).toBe(false);
    // v2.29.0: trip_entries.{time, poi_id} DROPPED. start_time / end_time 必出現。
    expect('startTime' in body).toBe(true);
    expect('endTime' in body).toBe(true);
    // migration 0078: entry-level note 已 DROP — 不再是 top-level 欄位。
    expect('note' in body).toBe(false);
    expect('poiId' in body).toBe(false);
    expect('entryPoisVersion' in body).toBe(true);
    expect(body.master?.name).toBe('Original POI');
    expect(body.master?.poiId).toBeGreaterThan(0);
    expect(body.stopPois).toHaveLength(1);
    expect(body.stopPois?.[0]?.sortOrder).toBe(1);
    expect(body.alternates).toEqual([]);
    // seedEntry 寫 start_time='10:00'
    expect(body.startTime).toBe('10:00');
  });

  it('未認證 + 非 published trip → 403（v2.33.97 sibling endpoint contract align requireTripReadAccess）', async () => {
    // seedTrip 預設 published=1 → anon 可讀 (與 sibling /days /segments 一致)。
    // 非 published trip 才 403 PERM_DENIED。建獨立 trip 避免污染其他 test。
    await seed({ id: 's8-entries-private', published: 0 });
    const privDayId = await getDayId(db, 's8-entries-private', 1);
    const privEntryId = await seedEntry(db, privDayId);
    expect((await api.get(`/api/trips/s8-entries-private/entries/${privEntryId}`)).status).toBe(403);
  });

  it('entry 不屬於該 trip → 404', async () => {
    await seed({ id: 's8-entries-other' });
    expect((await api.get(`/api/trips/s8-entries-other/entries/${entryId}`, { as: OWNER })).status).toBe(404);
  });

  it('entry id 不存在 → 404', async () => {
    expect((await api.get('/api/trips/s8-entries-e/entries/999999', { as: OWNER })).status).toBe(404);
  });
});

describe('PATCH /api/trips/:id/entries/:eid', () => {
  it('PATCH legacy title request → 400（entry display name no longer writable here）', async () => {
    const resp = await patchEntry('s8-entries-e', entryId, { title: 'Updated' });
    expect(resp.status).toBe(400);
    const { results } = await db.prepare("PRAGMA table_info('trip_entries')").all<{ name: string }>();
    expect(results.map((r) => r.name)).not.toContain('title');
  });

  it('migration 0078: PATCH 帶 note 連同合法欄位 → note 被 ALLOWED_FIELDS 過濾（不寫 trip_entries）', async () => {
    // 備註已搬到 trip_entry_pois（per-POI），entry-level note 端點不再接受 note。
    // 帶 note + 合法欄位（description）→ 200 但 note 被 whitelist 丟棄（trip_entries 已無此欄位）。
    const resp = await patchEntry('s8-entries-e', entryId, {
      description: 'Updated description',
      note: '應被忽略',
    });
    expect(resp.status).toBe(200);
    const row = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first<{ description: string }>();
    expect(row!.description).toBe('Updated description');
    // trip_entries 已無 note 欄位 → PRAGMA 確認
    const { results } = await db.prepare("PRAGMA table_info('trip_entries')").all<{ name: string }>();
    expect(results.map((r) => r.name)).not.toContain('note');
  });

  it('migration 0078: PATCH 只帶 note（無其他合法欄位）→ 400 無有效欄位可更新', async () => {
    const resp = await patchEntry('s8-entries-e', entryId, { note: '只有 note' });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('缺 title → 400', async () => {
    expect((await patchEntry('s8-entries-e', entryId, { title: '' })).status).toBe(400);
  });

  it('無 trip 寫入權限 → 403，entry 不被改', async () => {
    const before = await readTimes(entryId);
    const resp = await api.request('PATCH', `/api/trips/s8-entries-e/entries/${entryId}`, {
      as: STRANGER,
      json: { description: '陌生人改的' },
    });
    expect(resp.status).toBe(403);
    const row = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first<{ description: string | null }>();
    expect(row!.description).not.toBe('陌生人改的');
    expect(await readTimes(entryId)).toEqual(before);
  });

  it('entry 不屬於路徑上的 trip → 404，entry 不被改', async () => {
    await seed({ id: 's8-entries-other' });
    const resp = await patchEntry('s8-entries-other', entryId, { description: '跨 trip 改的' });
    expect(resp.status).toBe(404);
    const row = await db.prepare('SELECT description FROM trip_entries WHERE id = ?').bind(entryId).first<{ description: string | null }>();
    expect(row!.description).not.toBe('跨 trip 改的');
  });

  it('未認證 → 401', async () => {
    const resp = await api.request('PATCH', `/api/trips/s8-entries-e/entries/${entryId}`, {
      json: { title: 'x' },
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(resp.status).toBe(401);
  });

  // v2.26.0 (migration 0056) — start_time / end_time 拆分；v2.29.0 time col DROPPED。
  it('PATCH start_time + end_time → 寫入兩欄', async () => {
    const resp = await patchEntry('s8-entries-e', entryId, { start_time: '12:00', end_time: '13:30' });
    expect(resp.status).toBe(200);
    const row = await readTimes(entryId);
    expect(row!.start_time).toBe('12:00');
    expect(row!.end_time).toBe('13:30');
  });

  it('PATCH expectedVersion 不符 → 409 STALE_ENTRY 且不寫入；相符 → 200（補強 mutation 存活）', async () => {
    const cur = await db.prepare('SELECT version FROM trip_entries WHERE id = ?').bind(entryId).first<{ version: number }>();
    const stale = await patchEntry('s8-entries-e', entryId, { start_time: '05:55', expectedVersion: cur!.version + 99 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('STALE_ENTRY');
    expect((await readTimes(entryId))!.start_time).not.toBe('05:55');
    const ok = await patchEntry('s8-entries-e', entryId, { start_time: '05:55', expectedVersion: cur!.version });
    expect(ok.status).toBe(200);
    expect((await readTimes(entryId))!.start_time).toBe('05:55');
  });

  it('PATCH 只給 start_time → end_time 從現值繼承', async () => {
    // 先設一個基礎 end_time
    await db.prepare('UPDATE trip_entries SET end_time = ? WHERE id = ?').bind('15:00', entryId).run();

    expect((await patchEntry('s8-entries-e', entryId, { start_time: '14:00' })).status).toBe(200);
    const row = await readTimes(entryId);
    expect(row!.start_time).toBe('14:00');
    expect(row!.end_time).toBe('15:00');
  });

  it('PATCH legacy time "HH:MM-HH:MM" → parse 拆成 start_time / end_time', async () => {
    expect((await patchEntry('s8-entries-e', entryId, { time: '09:30-10:45' })).status).toBe(200);
    const row = await readTimes(entryId);
    expect(row!.start_time).toBe('09:30');
    expect(row!.end_time).toBe('10:45');
  });

  it('PATCH legacy time "HH:MM" → start_time = HH:MM, end_time = NULL', async () => {
    expect((await patchEntry('s8-entries-e', entryId, { time: '08:00' })).status).toBe(200);
    const row = await readTimes(entryId);
    expect(row!.start_time).toBe('08:00');
    expect(row!.end_time).toBeNull();
  });

  it('PATCH 無效 start_time format → 400', async () => {
    expect((await patchEntry('s8-entries-e', entryId, { start_time: '25:99' })).status).toBe(400);
  });

  it('PATCH start_time >= end_time → 400', async () => {
    expect((await patchEntry('s8-entries-e', entryId, { start_time: '14:00', end_time: '13:00' })).status).toBe(400);
  });

  it('PATCH 只給 start_time（晚於既有 end_time）→ effective merge 後 400', async () => {
    // 設 oldRow end_time = 13:30
    await db.prepare('UPDATE trip_entries SET start_time = ?, end_time = ? WHERE id = ?')
      .bind('12:00', '13:30', entryId).run();

    // 比 oldRow.end_time(13:30) 晚 → inverted
    expect((await patchEntry('s8-entries-e', entryId, { start_time: '15:00' })).status).toBe(400);

    // 沒被寫進去
    const row = await readTimes(entryId);
    expect(row!.start_time).toBe('12:00');
  });
});

describe('DELETE /api/trips/:id/entries/:eid', () => {
  it('刪除 entry → 200', async () => {
    const dayId = await getDayId(db, 's8-entries-e', 2);
    const eid = await seedEntry(db, dayId);
    const resp = await api.request('DELETE', `/api/trips/s8-entries-e/entries/${eid}`, {
      as: OWNER,
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(resp.status).toBe(200);
    const row = await db.prepare('SELECT * FROM trip_entries WHERE id = ?').bind(eid).first();
    expect(row).toBeNull();
  });
  it('無 trip 寫入權限 → 403，entry 仍在', async () => {
    const dayId = await getDayId(db, 's8-entries-e', 2);
    const eid = await seedEntry(db, dayId);
    const resp = await api.request('DELETE', `/api/trips/s8-entries-e/entries/${eid}`, {
      as: STRANGER,
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(resp.status).toBe(403);
    expect(await db.prepare('SELECT id FROM trip_entries WHERE id = ?').bind(eid).first()).not.toBeNull();
  });

  it('entry 不屬於路徑上的 trip → 404，entry 仍在', async () => {
    const dayId = await getDayId(db, 's8-entries-e', 2);
    const eid = await seedEntry(db, dayId);
    await seed({ id: 's8-entries-other' });
    const resp = await api.request('DELETE', `/api/trips/s8-entries-other/entries/${eid}`, {
      as: OWNER,
      headers: { Origin: BROWSER_ORIGIN },
    });
    expect(resp.status).toBe(404);
    expect(await db.prepare('SELECT id FROM trip_entries WHERE id = ?').bind(eid).first()).not.toBeNull();
  });
});
