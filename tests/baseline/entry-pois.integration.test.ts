/**
 * Integration tests — v2.27.0 multi-POI per entry endpoints
 * 走 HTTP 邊界（tests/api/http.ts），不直接呼叫 handler。
 *
 * Covers:
 *   - PATCH /api/trips/:id/entries/:eid/master       (swap + replace + OCC)
 *   - POST  /api/trips/:id/entries/:eid/alternates   (add)
 *   - DELETE /api/trips/:id/entries/:eid/alternates/:poiId  (remove)
 *   - PATCH /api/trips/:id/entries/:eid/alternates/reorder  (reorder)
 *   - segments stale marking after master swap
 *
 * 不是 handler 測試的部分（直接呼叫 _entry_pois 的 syncEntryMaster、直接對 D1 驗 FK cascade）
 * 在 tests/unit/entry-pois-module.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, seedPoi, getDayId } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

let db: D1Database;
let api: Api;
// 共用 D1：行程 id 一律以 's9-ep' 開頭、使用者用專用 email，afterAll 依此樣式清掉
const TRIP_ID = 's9-ep';
const OWNER = 's9-ep-owner@test.com';
const STRANGER = 's9-ep-stranger@test.com';
// 瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 handler 的 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
// 本檔直接建立的 POI id（handler 建立的 POI 由 afterAll 從 trip_entry_pois 反查）
const poiIds: number[] = [];

const track = <T extends { id: number } | null>(row: T): NonNullable<T> => {
  poiIds.push(row!.id);
  return row as NonNullable<T>;
};
const newPoi = async (name: string, type = 'attraction'): Promise<number> => {
  const id = await seedPoi(db, { name, type });
  poiIds.push(id);
  return id;
};

/** `as` 為 null 代表匿名（不帶 bearer）。 */
const call = (method: string, path: string, json?: unknown, as: string | null = OWNER) =>
  api.request(method, path, { as: as ?? undefined, json, headers: { Origin: BROWSER_ORIGIN } });
const entryPath = (eid: number, tail = '', tripId = TRIP_ID) => `/api/trips/${tripId}/entries/${eid}${tail}`;
const readVersion = async (entryId: number): Promise<number> => {
  const row = await db
    .prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?')
    .bind(entryId)
    .first<{ v: number }>();
  return row!.v;
};

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: BROWSER_ORIGIN }) });
  await seedTrip(db, { id: TRIP_ID, owner: OWNER });
}, 30000);

afterAll(async () => {
  // 先反查 handler 建立（搜尋 payload、re-point clone）的 POI，再清行程，最後刪 POI
  const linked = await db
    .prepare(
      `SELECT DISTINCT tep.poi_id AS id FROM trip_entry_pois tep
       JOIN trip_entries e ON e.id = tep.entry_id
       JOIN trip_days d ON d.id = e.day_id
       WHERE d.trip_id LIKE 's9-ep%'`,
    )
    .all<{ id: number }>();
  for (const r of linked.results) poiIds.push(r.id);
  await cleanupTrips(db, ['s9-ep%']);
  await db.prepare("DELETE FROM audit_log WHERE trip_id LIKE 's9-ep%'").run(); // 無 FK，要手動清
  for (const id of new Set(poiIds)) await db.prepare('DELETE FROM pois WHERE id = ?').bind(id).run();
  await disposeMiniflare();
});

// Helper: seed entry with master POI written to trip_entry_pois
// v2.29.0: seedEntry({ poiId }) 已自動 INSERT trip_entry_pois sort_order=1，不必再 explicit INSERT。
async function seedEntryWithMaster(opts: {
  poiName: string;
  altPoiNames?: string[];
}): Promise<{ entryId: number; masterPoiId: number; altPoiIds: number[] }> {
  const dayId = await getDayId(db, TRIP_ID, 1);
  const masterPoiId = await newPoi(opts.poiName);
  const entryId = await seedEntry(db, dayId, { poiId: masterPoiId });

  const altPoiIds: number[] = [];
  if (opts.altPoiNames) {
    for (let i = 0; i < opts.altPoiNames.length; i++) {
      const altId = await newPoi(opts.altPoiNames[i]!);
      altPoiIds.push(altId);
      await db
        .prepare(
          'INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, ?)',
        )
        .bind(entryId, altId, i + 2)
        .run();
    }
  }
  return { entryId, masterPoiId, altPoiIds };
}

describe('PATCH /master — swap existing alternate', () => {
  it('將 alternate sort_order=2 swap 成 master，舊 master 變 sort_order=2', async () => {
    const { entryId, masterPoiId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Master-Swap-A',
      altPoiNames: ['Alt-Swap-A-1'],
    });

    const resp = await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0] });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { masterPoiId: number; oldMasterPoiId: number; entryPoisVersion: string };
    expect(body.masterPoiId).toBe(altPoiIds[0]);
    expect(body.oldMasterPoiId).toBe(masterPoiId);
    expect(body.entryPoisVersion).toBeTruthy();

    // Verify DB state
    const newMaster = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number }>();
    expect(newMaster!.poi_id).toBe(altPoiIds[0]);

    const oldMaster = await db
      .prepare('SELECT sort_order FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, masterPoiId)
      .first<{ sort_order: number }>();
    expect(oldMaster!.sort_order).toBe(2);

    // v2.29.0: trip_entries.poi_id DROPPED. master 已從 trip_entry_pois sort_order=1 查過了 (line 104-108)。
  });
});

describe('PATCH /master — replace with new POI', () => {
  it('新 POI 不在 alternates → INSERT 為 master，舊 master 變 sort_order=max+1', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({
      poiName: 'Master-Replace-A',
      altPoiNames: ['Alt-Replace-1'],
    });
    const newPoiId = await newPoi('New-Replace-Master', 'restaurant');

    const resp = await call('PATCH', entryPath(entryId, '/master'), { poiId: newPoiId });
    expect(resp.status).toBe(200);

    const newMaster = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number }>();
    expect(newMaster!.poi_id).toBe(newPoiId);

    // 舊 master 變 max+1（原 alternate 在 sort_order=2，所以 max=2，舊 master 變 3）
    const oldMaster = await db
      .prepare('SELECT sort_order FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, masterPoiId)
      .first<{ sort_order: number }>();
    expect(oldMaster!.sort_order).toBe(3);
  });
});

describe('PATCH /master — OCC version', () => {
  it('expectedVersion mismatch → 409 STALE_ENTRY', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Master-OCC-A',
      altPoiNames: ['Alt-OCC-1'],
    });

    const resp = await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0], version: 'STALE-VERSION-TOKEN' });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STALE_ENTRY');
  });

  it('expectedVersion match → 200', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Master-OCC-B',
      altPoiNames: ['Alt-OCC-B1'],
    });

    // round 5 fix: OCC version is trip_entries.entry_pois_version (integer counter,
    // migration 0058). Read as string to match wire format.
    const v = await readVersion(entryId);

    const resp = await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0], version: String(v) });
    expect(resp.status).toBe(200);
  });
});

describe('PATCH /master — invalid input', () => {
  it('poiId 不存在 → 404', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'Master-NF-A' });
    expect((await call('PATCH', entryPath(entryId, '/master'), { poiId: 9999999 })).status).toBe(404);
  });

  it('poiId 缺漏 → 400', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'Master-NF-B' });
    expect((await call('PATCH', entryPath(entryId, '/master'), {})).status).toBe(400);
  });
});

describe('POST /alternates — add', () => {
  it('加 alternate → 201 sort_order = max+1', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AltAdd-Master' });
    const altPoiId = await newPoi('AltAdd-New-1');

    const resp = await call('POST', entryPath(entryId, '/alternates'), { poiId: altPoiId });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { sortOrder: number; entryPoisVersion: string };
    expect(body.sortOrder).toBe(2);
    expect(body.entryPoisVersion).toBeTruthy();
  });

  it('搜尋結果 payload → find-or-create POI 後加為 alternate', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AltAdd-Search-Master' });

    const resp = await call('POST', entryPath(entryId, '/alternates'), {
      name: 'AltAdd-Search-New',
      lat: 26.123,
      lng: 127.456,
      type: 'restaurant',
      category: 'restaurant',
      address: 'Okinawa',
      rating: 4.6,
      source: 'google',
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { poiId: number; sortOrder: number };
    expect(body.sortOrder).toBe(2);

    const poi = await db
      .prepare('SELECT name, type, category, address, rating FROM pois WHERE id = ?')
      .bind(body.poiId)
      .first<{ name: string; type: string; category: string | null; address: string | null; rating: number | null }>();
    expect(poi).toMatchObject({
      name: 'AltAdd-Search-New',
      type: 'restaurant',
      category: 'restaurant',
      address: 'Okinawa',
      rating: 4.6,
    });

    const link = await db
      .prepare('SELECT sort_order FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, body.poiId)
      .first<{ sort_order: number }>();
    expect(link?.sort_order).toBe(2);
  });

  it('已存在的 POI → 409 DUPLICATE_POI', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'AltAdd-DupMaster' });
    const resp = await call('POST', entryPath(entryId, '/alternates'), { poiId: masterPoiId });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DUPLICATE_POI');
  });

  it('entry 無 master → 400 MISSING_MASTER', async () => {
    const dayId = await getDayId(db, TRIP_ID, 1);
    const entryId = await seedEntry(db, dayId);
    const altPoiId = await newPoi('Lonely-Alt', 'restaurant');

    const resp = await call('POST', entryPath(entryId, '/alternates'), { poiId: altPoiId });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MISSING_MASTER');
  });

  // v2.33.106 T-7: 補 POST /alternates body validation 路徑 — 既有 coverage
  // 主要在 happy path / MISSING_MASTER / DUPLICATE_POI，缺 body shape / poiId 型別
  // / unknown poiId / empty body validation。
  describe('body validation (T-7)', () => {
    it('body 非 object (string) → 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-StringBody' });
      expect((await call('POST', entryPath(entryId, '/alternates'), 'a string')).status).toBe(400);
    });

    it('body 非 object (array) → 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-ArrayBody' });
      expect((await call('POST', entryPath(entryId, '/alternates'), [1, 2, 3])).status).toBe(400);
    });

    it('entryPoisVersion 非字串（number）→ 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-VersionType' });
      const altPoiId = await newPoi('AltValid-VersionTypePOI', 'restaurant');
      expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: altPoiId, entryPoisVersion: 123 })).status).toBe(400);
    });

    it('poiId 是負數 → 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-NegId' });
      expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: -5 })).status).toBe(400);
    });

    it('poiId 是 0 → 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-ZeroId' });
      expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: 0 })).status).toBe(400);
    });

    it('poiId 是非整數（小數）→ 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-FloatId' });
      expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: 3.14 })).status).toBe(400);
    });

    it('poiId 非數字（string）→ 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-StrId' });
      expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: 'abc' })).status).toBe(400);
    });

    it('poiId 指向不存在的 POI → 404', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-UnknownId' });
      expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: 99999999 })).status).toBe(404);
    });

    it('empty body（無 poiId 也無 name/lat/lng）→ 400', async () => {
      const { entryId } = await seedEntryWithMaster({ poiName: 'AltValid-Empty' });
      expect((await call('POST', entryPath(entryId, '/alternates'), {})).status).toBe(400);
    });
  });
});

describe('DELETE /alternates/:poiId — remove', () => {
  it('刪 alternate → 200', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AltDel-Master',
      altPoiNames: ['AltDel-1'],
    });

    const resp = await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[0]}`));
    expect(resp.status).toBe(200);

    const remaining = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entryId)
      .first<{ c: number }>();
    expect(remaining!.c).toBe(1); // 只剩 master
  });

  it('刪 master → 400（必須走 DELETE /entries/:id）', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'AltDel-CantRemoveMaster' });
    expect((await call('DELETE', entryPath(entryId, `/alternates/${masterPoiId}`))).status).toBe(400);
    // master 仍在
    const still = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ? AND sort_order = 1')
      .bind(entryId, masterPoiId)
      .first<{ c: number }>();
    expect(still!.c).toBe(1);
  });

  it('POI 不在 entry → 404 POI_NOT_ALTERNATE', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AltDel-NotFound' });
    const fakePoiId = await newPoi('AltDel-Fake', 'restaurant');
    const resp = await call('DELETE', entryPath(entryId, `/alternates/${fakePoiId}`));
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('POI_NOT_ALTERNATE');
  });
});

describe('PATCH /alternates/reorder', () => {
  it('合法 reorder → 200，sort_order 從 2 起依序', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Reorder-Master',
      altPoiNames: ['Re-1', 'Re-2', 'Re-3'],
    });
    // 原順序 [Re-1=2, Re-2=3, Re-3=4]，reorder 為 [Re-3, Re-1, Re-2]
    const reversed = [altPoiIds[2], altPoiIds[0], altPoiIds[1]];

    const resp = await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: reversed });
    expect(resp.status).toBe(200);

    const rows = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order')
      .bind(entryId)
      .all<{ poi_id: number; sort_order: number }>();
    expect(rows.results).toHaveLength(4); // master + 3 alternates
    expect(rows.results[1]!.poi_id).toBe(altPoiIds[2]); // Re-3 at order 2
    expect(rows.results[2]!.poi_id).toBe(altPoiIds[0]); // Re-1 at order 3
    expect(rows.results[3]!.poi_id).toBe(altPoiIds[1]); // Re-2 at order 4
  });

  it('length mismatch → 422 INVALID_ORDER', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Reorder-Mismatch',
      altPoiNames: ['Re-Mis-1', 'Re-Mis-2'],
    });
    const resp = await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: [altPoiIds[0]] }); // only 1 of 2
    expect(resp.status).toBe(422);
  });

  it('duplicates → 422 INVALID_ORDER', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Reorder-Dup',
      altPoiNames: ['Re-Dup-1', 'Re-Dup-2'],
    });
    const resp = await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: [altPoiIds[0], altPoiIds[0]] });
    expect(resp.status).toBe(422);
  });
});

// =========================================================================
// v2.27.0 ship coverage gaps — auth + perm + cross-trip + edge cases
// =========================================================================

describe('Auth & permission gates — PATCH /master', () => {
  it('未認證 → 401 AUTH_REQUIRED', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthMaster-A',
      altPoiNames: ['AuthMaster-Alt-1'],
    });
    expect((await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0] }, null)).status).toBe(401);
  });

  it('非 owner 無 write perm → 403 PERM_DENIED，master 不變', async () => {
    const { entryId, masterPoiId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthMaster-B',
      altPoiNames: ['AuthMaster-Alt-2'],
    });
    expect((await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0] }, STRANGER)).status).toBe(403);
    const master = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number }>();
    expect(master!.poi_id).toBe(masterPoiId);
  });

  it('cross-trip URL（entry 不屬於 URL 的 trip）→ 404 DATA_NOT_FOUND', async () => {
    // 另開一個 trip 並嘗試用該 trip URL 改原 trip 的 entry master
    await seedTrip(db, { id: 's9-ep-other', owner: OWNER });
    const { entryId, masterPoiId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'CrossTrip-A',
      altPoiNames: ['CrossTrip-Alt-1'],
    });
    expect((await call('PATCH', entryPath(entryId, '/master', 's9-ep-other'), { poiId: altPoiIds[0] })).status).toBe(404);
    const master = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number }>();
    expect(master!.poi_id).toBe(masterPoiId);
  });
});

describe('Auth & permission gates — POST /alternates', () => {
  it('未認證 → 401', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AuthAlt-A' });
    const altPoiId = await newPoi('AuthAlt-A-Alt');
    expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: altPoiId }, null)).status).toBe(401);
  });

  it('無 write perm → 403，alternate 不被新增', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AuthAlt-B' });
    const altPoiId = await newPoi('AuthAlt-B-Alt');
    expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: altPoiId }, STRANGER)).status).toBe(403);
    const count = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entryId)
      .first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it('poiId 缺漏 / 非正整數 → 400 DATA_VALIDATION', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AuthAlt-C' });
    expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: -1 })).status).toBe(400);
  });

  it('poiId 不存在 → 404 DATA_NOT_FOUND', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'AuthAlt-D' });
    expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: 9999999 })).status).toBe(404);
  });
});

describe('Auth & permission gates — DELETE /alternates/:poiId', () => {
  it('未認證 → 401', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthDel-A',
      altPoiNames: ['AuthDel-A-Alt'],
    });
    expect((await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[0]}`), undefined, null)).status).toBe(401);
  });

  it('無 write perm → 403，alternate 仍在', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthDel-B',
      altPoiNames: ['AuthDel-B-Alt'],
    });
    expect((await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[0]}`), undefined, STRANGER)).status).toBe(403);
    const count = await db
      .prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?')
      .bind(entryId)
      .first<{ c: number }>();
    expect(count!.c).toBe(2);
  });
});

describe('Auth & permission gates — PATCH /alternates/reorder', () => {
  it('未認證 → 401', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthReorder-A',
      altPoiNames: ['R-1', 'R-2'],
    });
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: [altPoiIds[1], altPoiIds[0]] }, null)).status).toBe(401);
  });

  it('無 write perm → 403，順序不變', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthReorder-Stranger',
      altPoiNames: ['R-S-1', 'R-S-2'],
    });
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: [altPoiIds[1], altPoiIds[0]] }, STRANGER)).status).toBe(403);
    const rows = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order > 1 ORDER BY sort_order')
      .bind(entryId)
      .all<{ poi_id: number }>();
    expect(rows.results.map((r) => r.poi_id)).toEqual(altPoiIds);
  });

  it('order 非 array → 422 INVALID_ORDER', async () => {
    const { entryId } = await seedEntryWithMaster({
      poiName: 'AuthReorder-B',
      altPoiNames: ['R-3'],
    });
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: 'not-array' })).status).toBe(422);
  });

  it('order 含非 integer → 422 INVALID_ORDER', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'AuthReorder-C',
      altPoiNames: ['R-4'],
    });
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: [altPoiIds[0], 'string'] })).status).toBe(422);
  });
});

describe('setMaster() edge cases', () => {
  it('no-op: poiId === 現有 master → 200 不變更 sort_order', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({
      poiName: 'NoOp-Master',
      altPoiNames: ['NoOp-Alt'],
    });
    const resp = await call('PATCH', entryPath(entryId, '/master'), { poiId: masterPoiId });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { masterPoiId: number; oldMasterPoiId: number };
    expect(body.masterPoiId).toBe(masterPoiId);
    expect(body.oldMasterPoiId).toBe(masterPoiId);
    // master 仍是同 POI
    const newMaster = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number }>();
    expect(newMaster!.poi_id).toBe(masterPoiId);
  });
});

describe('GET /api/trips/:id/days/:num — multi-POI surface', () => {
  it('回傳 timeline 含 master + alternates + entryPoisVersion', async () => {
    // days-num.test 已測 GET shape；此處重點是 multi-POI fields surface。
    const { entryId } = await seedEntryWithMaster({
      poiName: 'DaySurface-Master',
      altPoiNames: ['DaySurface-Alt-1', 'DaySurface-Alt-2'],
    });
    // 取得 entry 所在 dayNum
    const dayRow = await db
      .prepare(
        `SELECT d.day_num FROM trip_days d
         JOIN trip_entries e ON e.day_id = d.id
         WHERE e.id = ?`,
      )
      .bind(entryId)
      .first<{ day_num: number }>();
    expect(dayRow).not.toBeNull();
    const resp = await api.get(`/api/trips/${TRIP_ID}/days/${dayRow!.day_num}`, { as: OWNER });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      timeline: Array<{
        id: number;
        master: { poiId: number; name?: string | null } | null;
        alternates: Array<{ poiId: number; sortOrder: number }>;
        entryPoisVersion: string | null;
      }>;
    };
    const me = data.timeline.find((e) => e.id === entryId);
    expect(me).toBeDefined();
    expect(me!.master).not.toBeNull();
    expect(me!.master!.name).toBe('DaySurface-Master');
    expect(me!.alternates).toHaveLength(2);
    expect(me!.alternates[0]!.sortOrder).toBe(2);
    expect(me!.alternates[1]!.sortOrder).toBe(3);
    expect(me!.entryPoisVersion).toBeTruthy();
  });

  it('用餐 stop 的 master/stopPois 取 trip_entry_pois sort_order=1', async () => {
    // v2.29.0: trip_entries.poi_id DROPPED — master 由 trip_entry_pois.sort_order=1 唯一決定。
    const dayId = await getDayId(db, TRIP_ID, 1);
    const primaryRestaurant = track(await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Order One Ramen', 'restaurant') RETURNING id")
      .first<{ id: number }>());
    const alternateRestaurant = track(await db
      .prepare("INSERT INTO pois (name, type) VALUES ('Order Two Soba', 'restaurant') RETURNING id")
      .first<{ id: number }>());
    // 不傳 poiId 給 seedEntry 以避免 auto-INSERT trip_entry_pois 跟下方 explicit INSERT 衝突。
    const entryId = await seedEntry(db, dayId);
    await db.batch([
      db
        .prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)')
        .bind(entryId, primaryRestaurant.id),
      db
        .prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)')
        .bind(entryId, alternateRestaurant.id),
    ]);

    const resp = await api.get(`/api/trips/${TRIP_ID}/days/1`, { as: OWNER });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      timeline: Array<{
        id: number;
        stopPois?: Array<{ poiId: number; sortOrder: number; type: string; name: string }>;
        master: { poiId: number; type: string; name: string } | null;
        alternates: Array<{ poiId: number; sortOrder: number }>;
      }>;
    };
    const meal = data.timeline.find((e) => e.id === entryId);
    expect(meal).toBeDefined();
    expect(meal!.stopPois?.map((p) => [p.poiId, p.sortOrder])).toEqual([
      [primaryRestaurant.id, 1],
      [alternateRestaurant.id, 2],
    ]);
    expect('poiId' in meal!).toBe(false);
    expect('poi' in meal!).toBe(false);
    expect(meal!.master).toMatchObject({
      poiId: primaryRestaurant.id,
      type: 'restaurant',
      name: 'Order One Ramen',
    });
    expect(meal!.alternates[0]!.poiId).toBe(alternateRestaurant.id);
  });

  // v2.29.0: 「舊 trip_pois timeline rows 不會被 promoted」test removed — trip_pois table DROPPED。
});

describe('v2.28.0 — alternates 含 restaurant 欄位 (price/hours/reservation)', () => {
  it('alternates 從 fetchEntryPoisByEntries 帶出 trip_entry_pois metadata 欄位', async () => {
    // Seed: entry with master attraction + alt restaurant (poi.type='restaurant')
    const masterPoi = track(await db.prepare(
      "INSERT INTO pois (name, type) VALUES ('R-Master-Attraction', 'attraction') RETURNING id"
    ).first<{ id: number }>());
    const altRestaurant = track(await db.prepare(
      "INSERT INTO pois (name, type, hours, rating, price) VALUES ('R-Alt-Restaurant', 'restaurant', '11:00-22:00', 4.3, '$$') RETURNING id"
    ).first<{ id: number }>());
    const dayId = await getDayId(db, TRIP_ID, 1);
    // v2.29.0: trip_entries.{time, poi_id} DROPPED. 用 start_time + trip_entry_pois 寫 master。
    const entry = await db.prepare(
      "INSERT INTO trip_entries (day_id, sort_order, start_time) VALUES (?, 99, '18:00') RETURNING id"
    ).bind(dayId).first<{ id: number }>();

    await db.batch([
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, masterPoi.id),
      db.prepare(
        `INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, reservation, reservation_url, description)
         VALUES (?, ?, 2, ?, ?, ?)`
      ).bind(entry!.id, altRestaurant.id, '已訂位', 'https://example.com/reservation', '想試試特色料理'),
    ]);

    // Fetch via day GET
    const dayRow = await db.prepare(
      'SELECT day_num FROM trip_days WHERE id = ?'
    ).bind(dayId).first<{ day_num: number }>();
    const resp = await api.get(`/api/trips/${TRIP_ID}/days/${dayRow!.day_num}`, { as: OWNER });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      timeline: Array<{
        id: number;
        alternates: Array<{
          poiId: number;
          type?: string;
          hours?: string | null;
          rating?: number | null;
          price?: string | null;
          reservation?: string | null;
          reservationUrl?: string | null;
          description?: string | null;
        }>;
      }>;
    };
    const me = data.timeline.find((e) => e.id === entry!.id);
    expect(me).toBeDefined();
    expect(me!.alternates).toHaveLength(1);
    const alt = me!.alternates[0]!;
    expect(alt.poiId).toBe(altRestaurant.id);
    expect(alt.type).toBe('restaurant');
    // pois master fields
    expect(alt.hours).toBe('11:00-22:00');
    expect(alt.rating).toBe(4.3);
    expect(alt.price).toBe('$$');
    // trip_entry_pois metadata fields
    expect(alt.reservation).toBe('已訂位');
    expect(alt.reservationUrl).toBe('https://example.com/reservation');
    expect(alt.description).toBe('想試試特色料理');
  });

  it('non-restaurant alternates 不應 surface restaurant-specific fields 為 truthy', async () => {
    // v2.29.0: trip_pois override DROPPED. Master + 一個 attraction alt → price/reservation NULL。
    const masterPoi = track(await db.prepare(
      "INSERT INTO pois (name, type) VALUES ('R-Master2', 'attraction') RETURNING id"
    ).first<{ id: number }>());
    const altAttraction = track(await db.prepare(
      "INSERT INTO pois (name, type) VALUES ('R-Alt-Attraction', 'attraction') RETURNING id"
    ).first<{ id: number }>());
    const dayId = await getDayId(db, TRIP_ID, 1);
    const entry = await db.prepare(
      "INSERT INTO trip_entries (day_id, sort_order, start_time) VALUES (?, 100, '09:00') RETURNING id"
    ).bind(dayId).first<{ id: number }>();
    await db.batch([
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 1)').bind(entry!.id, masterPoi.id),
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)').bind(entry!.id, altAttraction.id),
    ]);

    const dayRow = await db.prepare(
      'SELECT day_num FROM trip_days WHERE id = ?'
    ).bind(dayId).first<{ day_num: number }>();
    const resp = await api.get(`/api/trips/${TRIP_ID}/days/${dayRow!.day_num}`, { as: OWNER });
    const data = (await resp.json()) as { timeline: Array<{ id: number; alternates: Array<{ price?: string | null; reservation?: string | null }> }> };
    const me = data.timeline.find((e) => e.id === entry!.id);
    const alt = me!.alternates.find((a) => a.price !== undefined || a.reservation !== undefined) ?? me!.alternates[0];
    expect(alt!.price).toBeNull();
    expect(alt!.reservation).toBeNull();
  });
});

describe('POST /api/trips/:id/days/:num/entries — syncEntryMaster', () => {
  it('POST 新 entry → 自動 INSERT trip_entry_pois sort_order=1（multi-POI invariant）', async () => {
    const resp = await call('POST', `/api/trips/${TRIP_ID}/days/1/entries`, {
      name: 'SyncMasterEntry-1',
      time: '14:00',
      poi_type: 'attraction',
      rating: 4.0,
    });
    expect(resp.status).toBe(201);
    const newEntry = (await resp.json()) as { id: number; poiId?: number; poi_id?: number };
    const newId = newEntry.id;
    expect(newId).toBeGreaterThan(0);

    // 驗證 trip_entry_pois 有 sort_order=1 row
    const row = await db
      .prepare(
        'SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1',
      )
      .bind(newId)
      .first<{ poi_id: number; sort_order: number }>();
    expect(row).not.toBeNull();
    expect(row!.sort_order).toBe(1);
    expect(row!.poi_id).toBeGreaterThan(0);
    // v2.29.0: trip_entries.poi_id DROPPED — master 唯一來源是 trip_entry_pois sort_order=1。
  });

  it('migration 0078: POST 帶 note → 寫進 master trip_entry_pois.note（非 trip_entries）', async () => {
    const resp = await call('POST', `/api/trips/${TRIP_ID}/days/1/entries`, {
      name: 'PostNoteEntry',
      time: '15:00',
      poi_type: 'restaurant',
      note: '必點招牌拉麵',
    });
    expect(resp.status).toBe(201);
    const newEntry = (await resp.json()) as { id: number };
    const master = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(newEntry.id)
      .first<{ note: string | null }>();
    expect(master!.note).toBe('必點招牌拉麵');
  });

  it('migration 0078: POST 帶亂碼 note → 400 DATA_ENCODING', async () => {
    const resp = await call('POST', `/api/trips/${TRIP_ID}/days/1/entries`, {
      name: 'PostGarbledNote',
      time: '16:00',
      poi_type: 'restaurant',
      note: '備註���亂碼',
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_ENCODING');
  });
});

describe('POST /api/trips/:id/entries/:eid/copy — syncEntryMaster', () => {
  it('copy entry 到別天 → 新 entry 複製 canonical stopPois 順序', async () => {
    const { entryId: srcEntryId, masterPoiId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'Copy-Master',
      altPoiNames: ['Copy-Alt'],
    });
    const targetDayId = await getDayId(db, TRIP_ID, 2);
    const resp = await call('POST', entryPath(srcEntryId, '/copy'), { targetDayId });
    expect(resp.status).toBe(200);
    const newRow = (await resp.json()) as { id: number };
    expect(newRow.id).not.toBe(srcEntryId);

    const copiedRows = await db
      .prepare(
        'SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order',
      )
      .bind(newRow.id)
      .all<{ poi_id: number; sort_order: number }>();
    expect(copiedRows.results.map((row) => [row.poi_id, row.sort_order])).toEqual([
      [masterPoiId, 1],
      [altPoiIds[0], 2],
    ]);
  });
});

describe('Segment recompute trigger', () => {
  it('master swap → from/to segments marked stale', async () => {
    // 設 2 個 entries 在同 day + segment 連接
    const dayId = await getDayId(db, TRIP_ID, 1);
    const p1 = await newPoi('Seg-P1');
    const p2 = await newPoi('Seg-P2');
    const altP = await newPoi('Seg-Alt');
    // v2.29.0: seedEntry({poiId}) 自動 INSERT trip_entry_pois sort_order=1，不必再 explicit INSERT master。
    const e1 = await seedEntry(db, dayId, { poiId: p1 });
    const e2 = await seedEntry(db, dayId, { poiId: p2, sortOrder: 2 });
    await db.batch([
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)').bind(e2, altP),
      db
        .prepare(
          "INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, source, computed_at) VALUES (?, ?, ?, 'driving', 10, 'google', datetime('now'))",
        )
        .bind(TRIP_ID, e1, e2),
    ]);

    // master swap on e2 (altP → master)
    const resp = await call('PATCH', entryPath(e2, '/master'), { poiId: altP });
    expect(resp.status).toBe(200);

    const seg = await db
      .prepare('SELECT source, computed_at, updated_at FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?')
      .bind(e1, e2)
      .first<{ source: string; computed_at: string | null; updated_at: number | null }>();
    // trip_segments.source CHECK 不允許 'stale'；改用 computed_at=NULL 標 stale + bump updated_at
    expect(seg!.computed_at).toBeNull();
    expect(seg!.updated_at).toBeGreaterThan(0);
  });

  // v2.55.46 Finding D: 端點 POI 真的換掉 → 「同一地點/免交通」前提失效 → 清 no_travel 讓它重算。
  it('master swap → 相鄰 no_travel 段清成 NULL（端點變了，同一地點前提失效）', async () => {
    const dayId = await getDayId(db, TRIP_ID, 1);
    const p1 = await newPoi('NT-P1');
    const p2 = await newPoi('NT-P2');
    const altP = await newPoi('NT-Alt');
    const e1 = await seedEntry(db, dayId, { poiId: p1 });
    const e2 = await seedEntry(db, dayId, { poiId: p2, sortOrder: 2 });
    await db.batch([
      db.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order) VALUES (?, ?, 2)').bind(e2, altP),
      // 同一地點段：no_travel=1、min/source NULL（POST/PATCH 不變式）
      db.prepare("INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, no_travel) VALUES (?, ?, ?, 'walking', 1)").bind(TRIP_ID, e1, e2),
    ]);
    const resp = await call('PATCH', entryPath(e2, '/master'), { poiId: altP });
    expect(resp.status).toBe(200);
    const seg = await db
      .prepare('SELECT no_travel, computed_at FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?')
      .bind(e1, e2)
      .first<{ no_travel: number | null; computed_at: string | null }>();
    expect(seg!.no_travel).toBeNull();   // 端點換了 → 清 no_travel，recompute 可重算
    expect(seg!.computed_at).toBeNull();
  });

  it('no-op setMaster（poiId 沒變）→ no_travel 保留（同一地點前提仍成立）', async () => {
    const dayId = await getDayId(db, TRIP_ID, 1);
    const p1 = await newPoi('NT2-P1');
    const p2 = await newPoi('NT2-P2');
    const e1 = await seedEntry(db, dayId, { poiId: p1 });
    const e2 = await seedEntry(db, dayId, { poiId: p2, sortOrder: 2 });
    await db
      .prepare("INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, no_travel) VALUES (?, ?, ?, 'walking', 1)")
      .bind(TRIP_ID, e1, e2)
      .run();
    // setMaster 帶「現有 master」→ 走 no-op drift-repair 路徑（POI 未變）
    const resp = await call('PATCH', entryPath(e2, '/master'), { poiId: p2 });
    expect(resp.status).toBe(200);
    const seg = await db
      .prepare('SELECT no_travel FROM trip_segments WHERE from_entry_id = ? AND to_entry_id = ?')
      .bind(e1, e2)
      .first<{ no_travel: number | null }>();
    expect(seg!.no_travel).toBe(1);   // POI 沒變 → 同一地點標記保留
  });
});

// ============================================================================
// Round 4 pre-landing fixes — regression tests for newly-fixed bugs
// ============================================================================

describe('Round 4 — OCC monotonic across removeAlternate (Codex F2 fix)', () => {
  it('removeAlternate 後 version 不會 backward (trip_entries.updated_at monotonic)', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'F2-Master',
      altPoiNames: ['F2-Alt-1', 'F2-Alt-2'],
    });

    // round 5 fix: OCC source is now trip_entries.entry_pois_version (integer counter).
    // Read before-version, removeAlternate, assert after-version > before-version.
    const before = await readVersion(entryId);

    const resp = await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[1]}`));
    expect(resp.status).toBe(200);

    const after = await readVersion(entryId);
    // Monotonic counter: after > before, by exactly 1 (single mutation).
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(before + 1);
  });
});

describe('Round 4 — Alternates CRUD OCC enforcement (Codex F3 fix)', () => {
  it('POST /alternates with stale entryPoisVersion → 409 STALE_ENTRY', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'F3-Master' });
    const newAltPoi = await newPoi('F3-NewAlt');

    // round 5 fix: OCC is integer counter. Stale = a high number that's clearly past the current value.
    // Fresh entries start at 0 (DEFAULT) or 1 (after a setMaster/seed); '99999' is unambiguously stale.
    const resp = await call('POST', entryPath(entryId, '/alternates'), {
      poiId: newAltPoi,
      entryPoisVersion: '99999', // unambiguously stale (current is 0 or 1)
    });
    expect(resp.status).toBe(409);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('STALE_ENTRY');
  });

  it('DELETE /alternates/:poiId?entryPoisVersion=stale → 409 STALE_ENTRY', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'F3-DelMaster',
      altPoiNames: ['F3-DelAlt'],
    });
    const resp = await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[0]}?entryPoisVersion=99999`));
    expect(resp.status).toBe(409);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('STALE_ENTRY');
  });

  it('PATCH /alternates/reorder with stale entryPoisVersion → 409 STALE_ENTRY', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'F3-ReorderMaster',
      altPoiNames: ['F3-R-1', 'F3-R-2'],
    });
    const resp = await call('PATCH', entryPath(entryId, '/alternates/reorder'), {
      order: [altPoiIds[1], altPoiIds[0]],
      entryPoisVersion: '99999',
    });
    expect(resp.status).toBe(409);
    const body = await resp.json() as { error: { code: string } };
    expect(body.error.code).toBe('STALE_ENTRY');
  });
});

describe('Round 4 — PATCH /master accepts both body field names (A1 fix)', () => {
  it('body `entryPoisVersion` (canonical) works', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'A1-canonical',
      altPoiNames: ['A1-canonical-alt'],
    });
    // round 5 fix: OCC source is trip_entries.entry_pois_version (integer counter)
    const v = await readVersion(entryId);
    const resp = await call('PATCH', entryPath(entryId, '/master'), {
      poiId: altPoiIds[0],
      entryPoisVersion: String(v),
    });
    expect(resp.status).toBe(200);
  });

  it('body legacy `version` still works (backwards compat)', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'A1-legacy',
      altPoiNames: ['A1-legacy-alt'],
    });
    const v = await readVersion(entryId);
    const resp = await call('PATCH', entryPath(entryId, '/master'), {
      poiId: altPoiIds[0],
      version: String(v),
    });
    expect(resp.status).toBe(200);
  });
});

// Round 5 regression: cross-mutation OCC false-positive fix
// Round 4 made OCC source = trip_entries.updated_at; PATCH /entries note edit bumped that
// column and silently invalidated entryPoisVersion. Round 5 moved OCC to dedicated counter
// trip_entries.entry_pois_version which ONLY multi-POI helpers touch.
describe('Round 5 — entry_pois_version isolated from unrelated entry edits (cross-mutation fix)', () => {
  it('PATCH /entries note edit (real handler) does not invalidate entry_pois_version', async () => {
    // round 7 fix: 透過真實 PATCH /entries handler 而非 raw SQL — 若未來有人把
    // entry_pois_version 加入 ALLOWED_FIELDS（誤以為 client 需要 patch），raw SQL
    // test 不會 catch 但這 test 會。
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'R5-CrossMutation',
      altPoiNames: ['R5-Alt'],
    });
    const v0 = await readVersion(entryId);

    // PATCH /entries via real handler — note + time edit 都該 NOT bump entry_pois_version
    const patchResp = await call('PATCH', entryPath(entryId), {
      note: '更新備註',
      start_time: '09:30',
      end_time: '11:00',
    });
    expect(patchResp.status).toBe(200);

    expect(await readVersion(entryId)).toBe(v0); // unchanged — round 5 invariant

    // setMaster with the original version should still succeed
    const resp = await call('PATCH', entryPath(entryId, '/master'), {
      poiId: altPoiIds[0],
      entryPoisVersion: String(v0),
    });
    expect(resp.status).toBe(200);
  });

  it('PATCH /entries body 不接受 entry_pois_version (mass assignment 防護)', async () => {
    // round 7 fix: 確認 ALLOWED_FIELDS whitelist 排除 entry_pois_version，
    // attacker / buggy client 送 body 帶 entry_pois_version: 99999 不該影響 column。
    const { entryId } = await seedEntryWithMaster({
      poiName: 'R7-MassAssign',
      altPoiNames: [],
    });
    const v0 = await readVersion(entryId);

    await call('PATCH', entryPath(entryId), {
      note: 'ok',
      // injection attempt — should be silently dropped by ALLOWED_FIELDS filter
      entry_pois_version: 99999,
      entryPoisVersion: 99999,
    });

    expect(await readVersion(entryId)).toBe(v0);
  });
});

// =============================================================================
// PATCH /api/trips/:id/entries/:eid/pois/:poiId — per-POI 備註（取代 entry-level note）
// migration 0078 cutover：master(sort_order=1) 或 alternate(sort_order>1) 各自可編輯 note。
// =============================================================================
describe('PATCH /pois/:poiId — per-POI note', () => {
  /** `as` 為 null 代表匿名；tripId 預設為本檔的行程。 */
  const patchNote = (entryId: number, poiId: number, body: unknown, as: string | null = OWNER, tripId = TRIP_ID) =>
    call('PATCH', entryPath(entryId, `/pois/${poiId}`, tripId), body, as);

  async function readNote(entryId: number, poiId: number): Promise<string | null> {
    const row = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, poiId)
      .first<{ note: string | null }>();
    return row ? row.note : null;
  }

  it('成功更新 master(sort_order=1) note → 200 + DB 寫入', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-Master' });
    const resp = await patchNote(entryId, masterPoiId, { note: '必點山苦瓜炒麵' });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { entryId: number; poiId: number; note: string };
    expect(body.poiId).toBe(masterPoiId);
    expect(body.note).toBe('必點山苦瓜炒麵');
    expect(await readNote(entryId, masterPoiId)).toBe('必點山苦瓜炒麵');
  });

  it('成功更新 alternate(sort_order>1) note → 200', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({
      poiName: 'PN-AltMaster',
      altPoiNames: ['PN-Alt-1'],
    });
    const resp = await patchNote(entryId, altPoiIds[0]!, { note: '週三休息' });
    expect(resp.status).toBe(200);
    expect(await readNote(entryId, altPoiIds[0]!)).toBe('週三休息');
  });

  it('note 純空白 → 寫 null（清除）', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-Blank' });
    // 先寫一個值
    await db.prepare('UPDATE trip_entry_pois SET note = ? WHERE entry_id = ? AND poi_id = ?')
      .bind('舊備註', entryId, masterPoiId).run();
    const resp = await patchNote(entryId, masterPoiId, { note: '   ' });
    expect(resp.status).toBe(200);
    expect(await readNote(entryId, masterPoiId)).toBeNull();
  });

  it('note = null → 寫 null', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-Null' });
    await db.prepare('UPDATE trip_entry_pois SET note = ? WHERE entry_id = ? AND poi_id = ?')
      .bind('舊備註', entryId, masterPoiId).run();
    const resp = await patchNote(entryId, masterPoiId, { note: null });
    expect(resp.status).toBe(200);
    expect(await readNote(entryId, masterPoiId)).toBeNull();
  });

  it('亂碼（U+FFFD）→ 400 DATA_ENCODING', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-Garbled' });
    const resp = await patchNote(entryId, masterPoiId, { note: '備註���' });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_ENCODING');
  });

  it('note 超過 1000 字 → 400 DATA_VALIDATION', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-TooLong' });
    const resp = await patchNote(entryId, masterPoiId, { note: 'あ'.repeat(1001) });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('缺 note 欄位 → 400 DATA_VALIDATION', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-MissingField' });
    const resp = await patchNote(entryId, masterPoiId, {});
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('note 非 string|null（number）→ 400 DATA_VALIDATION', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-WrongType' });
    const resp = await patchNote(entryId, masterPoiId, { note: 123 });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('poiId 不屬於該 entry → 404 DATA_NOT_FOUND', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'PN-NotInEntry' });
    const strayPoi = await newPoi('PN-Stray');
    const resp = await patchNote(entryId, strayPoi, { note: '不該成功' });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_NOT_FOUND');
  });

  it('未認證 → 401 AUTH_REQUIRED', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-NoAuth' });
    const resp = await patchNote(entryId, masterPoiId, { note: 'x' }, null);
    expect(resp.status).toBe(401);
  });

  it('無 write 權限（陌生人）→ 403 PERM_DENIED，note 不被改', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-Stranger' });
    const resp = await patchNote(entryId, masterPoiId, { note: 'x' }, STRANGER);
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PERM_DENIED');
    expect(await readNote(entryId, masterPoiId)).toBeNull();
  });

  it('cross-trip：URL trip 與 entry 所屬 trip 不符 → 404 DATA_NOT_FOUND', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-CrossTrip' });
    // 另開一個 trip，owner 同 OWNER（有 write 權限），但 entry 屬於 TRIP_ID。
    const otherTrip = 's9-ep-other-note';
    await seedTrip(db, { id: otherTrip, owner: OWNER });
    const resp = await patchNote(entryId, masterPoiId, { note: 'x' }, OWNER, otherTrip);
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DATA_NOT_FOUND');
    expect(await readNote(entryId, masterPoiId)).toBeNull();
  });

  it('回歸：note 編輯不 bump entry_pois_version（LWW，不誤殺 swap token）', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-NoVersionBump' });
    const before = await readVersion(entryId);
    const resp = await patchNote(entryId, masterPoiId, { note: '不該 bump version' });
    expect(resp.status).toBe(200);
    expect(await readVersion(entryId)).toBe(before); // 不變
  });

  it('updated_at 被更新（trip_entry_pois.updated_at 推進）', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PN-UpdatedAt' });
    // 先把 updated_at 設成過去值
    await db.prepare("UPDATE trip_entry_pois SET updated_at = '2000-01-01T00:00:00.000Z' WHERE entry_id = ? AND poi_id = ?")
      .bind(entryId, masterPoiId).run();
    const resp = await patchNote(entryId, masterPoiId, { note: 'x' });
    expect(resp.status).toBe(200);
    const row = await db
      .prepare('SELECT updated_at FROM trip_entry_pois WHERE entry_id = ? AND poi_id = ?')
      .bind(entryId, masterPoiId)
      .first<{ updated_at: string }>();
    expect(row!.updated_at > '2000-01-01T00:00:00.000Z').toBe(true);
  });
});

describe('PATCH /pois/:poiId — poi_type (change category via re-point)', () => {
  const patchPoi = (entryId: number, poiId: number, body: unknown) =>
    call('PATCH', entryPath(entryId, `/pois/${poiId}`), body);
  const masterRow = (entryId: number) =>
    db
      .prepare(
        'SELECT p.id, p.type, p.name FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id WHERE tep.entry_id = ? AND tep.sort_order = 1',
      )
      .bind(entryId)
      .first<{ id: number; type: string; name: string }>();

  it('re-types the master POI: re-points the entry to a (name, new-type) row', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT Master' });
    const resp = await patchPoi(entryId, masterPoiId, { poi_type: 'restaurant' });
    expect(resp.status).toBe(200);
    const row = await masterRow(entryId);
    expect(row!.type).toBe('restaurant');
    expect(row!.name).toBe('PT Master');
    expect(row!.id).not.toBe(masterPoiId); // re-pointed, not the old attraction row
  });

  it('collision: re-points to the EXISTING (name, target-type) row, never a duplicate', async () => {
    const preId = await newPoi('PT Collide', 'restaurant');
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT Collide' });
    const resp = await patchPoi(entryId, masterPoiId, { poi_type: 'restaurant' });
    expect(resp.status).toBe(200);
    expect((await masterRow(entryId))!.id).toBe(preId);
    const cnt = await db
      .prepare("SELECT count(*) AS n FROM pois WHERE name = 'PT Collide' AND type = 'restaurant'")
      .first<{ n: number }>();
    expect(cnt!.n).toBe(1);
  });

  it('rejects an invalid poi_type with 400', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT Bad' });
    const resp = await patchPoi(entryId, masterPoiId, { note: 'x', poi_type: 'bogus' });
    expect(resp.status).toBe(400);
  });

  it('note-only PATCH still works (existing behavior preserved)', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT NoteOnly' });
    const resp = await patchPoi(entryId, masterPoiId, { note: 'hello' });
    expect(resp.status).toBe(200);
    const row = await db
      .prepare('SELECT note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ note: string }>();
    expect(row!.note).toBe('hello');
  });

  // 資料保真：re-point 建出全新 (name, newType) clone 時，要帶上來源 POI 的
  // lifecycle 狀態（migration 0051 status / status_reason / status_checked_at），
  // 否則對「永久歇業」的 POI 換分類會讓 clone 預設回 active、歇業警告消失。
  it('preserves lifecycle status when re-pointing creates a new (name, type) clone', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT Closed' });
    await db
      .prepare(
        "UPDATE pois SET status = 'closed', status_reason = '永久歇業', status_checked_at = '2026-05-01T00:00:00.000Z' WHERE id = ?",
      )
      .bind(masterPoiId)
      .run();

    const resp = await patchPoi(entryId, masterPoiId, { poi_type: 'restaurant' });
    expect(resp.status).toBe(200);

    const row = await db
      .prepare(
        'SELECT p.id, p.status, p.status_reason, p.status_checked_at FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id WHERE tep.entry_id = ? AND tep.sort_order = 1',
      )
      .bind(entryId)
      .first<{ id: number; status: string; status_reason: string | null; status_checked_at: string | null }>();
    expect(row!.id).not.toBe(masterPoiId); // 確實是新 clone
    expect(row!.status).toBe('closed'); // 不應被重設為 active
    expect(row!.status_reason).toBe('永久歇業');
    expect(row!.status_checked_at).toBe('2026-05-01T00:00:00.000Z');
  });

  // 反向保護：re-point 撞到既有同名同類 row（merge）時，**不可**用來源的
  // 歇業狀態覆寫該既有 row 自己的 lifecycle（它是另一個真實地點、自有狀態）。
  // 此測試同時鎖死「status 不得進 COALESCE_FIELDS」的設計決策。
  it('merge case: re-pointing a closed POI onto an existing active row keeps that row active', async () => {
    const preId = await newPoi('PT MergeActive', 'restaurant');
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT MergeActive' });
    await db
      .prepare("UPDATE pois SET status = 'closed', status_reason = '永久歇業' WHERE id = ?")
      .bind(masterPoiId)
      .run();

    const resp = await patchPoi(entryId, masterPoiId, { poi_type: 'restaurant' });
    expect(resp.status).toBe(200);
    expect((await masterRow(entryId))!.id).toBe(preId);

    const target = await db
      .prepare('SELECT status, status_reason FROM pois WHERE id = ?')
      .bind(preId)
      .first<{ status: string; status_reason: string | null }>();
    expect(target!.status).toBe('active'); // 既有 row 自己的 lifecycle 不被動到
    expect(target!.status_reason).toBeNull();
  });
});

// =============================================================================
// 以下為轉 HTTP 邊界時 mutation 驗證發現的缺口（拿掉檢查／改壞實作測試仍綠），一併補上。
// =============================================================================
describe('mutation 補洞 — entry 歸屬（cross-trip）', () => {
  it('POST /alternates：URL trip 與 entry 所屬 trip 不符 → 404，不新增', async () => {
    await seedTrip(db, { id: 's9-ep-other-alt', owner: OWNER });
    const { entryId } = await seedEntryWithMaster({ poiName: 'XT-Add-Master' });
    const altPoiId = await newPoi('XT-Add-Alt');
    expect((await call('POST', entryPath(entryId, '/alternates', 's9-ep-other-alt'), { poiId: altPoiId })).status).toBe(404);
    const c = await db.prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?').bind(entryId).first<{ c: number }>();
    expect(c!.c).toBe(1);
  });

  it('DELETE /alternates/:poiId：URL trip 與 entry 所屬 trip 不符 → 404，alternate 仍在', async () => {
    await seedTrip(db, { id: 's9-ep-other-del', owner: OWNER });
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'XT-Del-Master', altPoiNames: ['XT-Del-Alt'] });
    expect((await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[0]}`, 's9-ep-other-del'))).status).toBe(404);
    const c = await db.prepare('SELECT COUNT(*) AS c FROM trip_entry_pois WHERE entry_id = ?').bind(entryId).first<{ c: number }>();
    expect(c!.c).toBe(2);
  });

  it('PATCH /alternates/reorder：URL trip 與 entry 所屬 trip 不符 → 404，順序不變', async () => {
    await seedTrip(db, { id: 's9-ep-other-re', owner: OWNER });
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'XT-Re-Master', altPoiNames: ['XT-Re-1', 'XT-Re-2'] });
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder', 's9-ep-other-re'), { order: [altPoiIds[1], altPoiIds[0]] })).status).toBe(404);
    const rows = await db
      .prepare('SELECT poi_id FROM trip_entry_pois WHERE entry_id = ? AND sort_order > 1 ORDER BY sort_order')
      .bind(entryId)
      .all<{ poi_id: number }>();
    expect(rows.results.map((r) => r.poi_id)).toEqual(altPoiIds);
  });
});

describe('mutation 補洞 — master 輸入與 OCC 欄位名', () => {
  it('poiId 是 0 → 400（不是 404）', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'M-ZeroId' });
    expect((await call('PATCH', entryPath(entryId, '/master'), { poiId: 0 })).status).toBe(400);
  });

  it('body entryPoisVersion 過期 → 409 STALE_ENTRY（canonical 欄位名也要被檢查）', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'M-StaleCanonical', altPoiNames: ['M-StaleCanonical-Alt'] });
    const resp = await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0], entryPoisVersion: '99999' });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STALE_ENTRY');
  });

  it('swap 成功 → entry_pois_version +1（OCC token 前進）', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'M-VersionBump', altPoiNames: ['M-VersionBump-Alt'] });
    const before = await readVersion(entryId);
    expect((await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0] })).status).toBe(200);
    expect(await readVersion(entryId)).toBe(before + 1);
  });
});

describe('mutation 補洞 — reorder 結果與版本', () => {
  it('reorder 後 sort_order 恰為 2,3,4，且 entry_pois_version +1', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'Re-Exact', altPoiNames: ['Re-E1', 'Re-E2', 'Re-E3'] });
    const before = await readVersion(entryId);
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order: [altPoiIds[1], altPoiIds[2], altPoiIds[0]] })).status).toBe(200);
    const rows = await db
      .prepare('SELECT poi_id, sort_order FROM trip_entry_pois WHERE entry_id = ? ORDER BY sort_order')
      .bind(entryId)
      .all<{ poi_id: number; sort_order: number }>();
    expect(rows.results.map((r) => r.sort_order)).toEqual([1, 2, 3, 4]);
    expect(rows.results.slice(1).map((r) => r.poi_id)).toEqual([altPoiIds[1], altPoiIds[2], altPoiIds[0]]);
    expect(await readVersion(entryId)).toBe(before + 1);
  });
});

describe('mutation 補洞 — PATCH /pois/:poiId 同時換分類與 note', () => {
  it('poi_type + note 一起送 → note 寫在 re-point 後的新 row，舊 row 不被寫', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'PT RePointNote' });
    const resp = await call('PATCH', entryPath(entryId, `/pois/${masterPoiId}`), { poi_type: 'restaurant', note: '換分類也要帶備註' });
    expect(resp.status).toBe(200);
    const master = await db
      .prepare('SELECT poi_id, note FROM trip_entry_pois WHERE entry_id = ? AND sort_order = 1')
      .bind(entryId)
      .first<{ poi_id: number; note: string | null }>();
    expect(master!.poi_id).not.toBe(masterPoiId);
    expect(master!.note).toBe('換分類也要帶備註');
  });
});

describe('mutation 補洞 — 寫入會留下 audit_log', () => {
  const lastAudit = (entryId: number) =>
    db
      .prepare("SELECT action, changed_by, diff_json FROM audit_log WHERE trip_id = ? AND table_name = 'trip_entry_pois' AND record_id = ? ORDER BY id DESC LIMIT 1")
      .bind(TRIP_ID, entryId)
      .first<{ action: string; changed_by: string; diff_json: string }>();

  it('master swap → update，diff 記錄 from/to', async () => {
    const { entryId, masterPoiId, altPoiIds } = await seedEntryWithMaster({ poiName: 'Aud-M', altPoiNames: ['Aud-M-Alt'] });
    expect((await call('PATCH', entryPath(entryId, '/master'), { poiId: altPoiIds[0] })).status).toBe(200);
    const row = await lastAudit(entryId);
    expect(row).toMatchObject({ action: 'update', changed_by: OWNER });
    expect(JSON.parse(row!.diff_json)).toEqual({ master_swap: { from: masterPoiId, to: altPoiIds[0] } });
  });

  it('加 alternate → insert，diff 記錄 poi 與 sort_order', async () => {
    const { entryId } = await seedEntryWithMaster({ poiName: 'Aud-A' });
    const altPoiId = await newPoi('Aud-A-Alt');
    expect((await call('POST', entryPath(entryId, '/alternates'), { poiId: altPoiId })).status).toBe(201);
    const row = await lastAudit(entryId);
    expect(row).toMatchObject({ action: 'insert', changed_by: OWNER });
    expect(JSON.parse(row!.diff_json)).toEqual({ alt_added: altPoiId, sort_order: 2 });
  });

  it('刪 alternate → delete，diff 記錄被移除的 poi', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'Aud-D', altPoiNames: ['Aud-D-Alt'] });
    expect((await call('DELETE', entryPath(entryId, `/alternates/${altPoiIds[0]}`))).status).toBe(200);
    const row = await lastAudit(entryId);
    expect(row).toMatchObject({ action: 'delete', changed_by: OWNER });
    expect(JSON.parse(row!.diff_json)).toEqual({ alt_removed: altPoiIds[0] });
  });

  it('reorder → update，diff 記錄新順序', async () => {
    const { entryId, altPoiIds } = await seedEntryWithMaster({ poiName: 'Aud-R', altPoiNames: ['Aud-R-1', 'Aud-R-2'] });
    const order = [altPoiIds[1], altPoiIds[0]];
    expect((await call('PATCH', entryPath(entryId, '/alternates/reorder'), { order })).status).toBe(200);
    const row = await lastAudit(entryId);
    expect(row).toMatchObject({ action: 'update', changed_by: OWNER });
    expect(JSON.parse(row!.diff_json)).toEqual({ reordered: order });
  });

  it('PATCH /pois/:poiId note → update', async () => {
    const { entryId, masterPoiId } = await seedEntryWithMaster({ poiName: 'Aud-N' });
    expect((await call('PATCH', entryPath(entryId, `/pois/${masterPoiId}`), { note: '稽核備註' })).status).toBe(200);
    const row = await lastAudit(entryId);
    expect(row).toMatchObject({ action: 'update', changed_by: OWNER });
    expect(row!.diff_json).toContain('稽核備註');
  });
});
