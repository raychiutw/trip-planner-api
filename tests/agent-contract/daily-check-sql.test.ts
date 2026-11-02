/**
 * agent 的 daily-check 送給 D1 的 SQL，必須能在「現行 api migrations」的 schema 上執行。
 * （agent 改了欄位名／表名、或 api 的 migration 改了 schema，這裡會紅，而不是 production 的每日健檢靜默壞掉。）
 *
 * 範圍說明：SQL 內嵌的門檻（HAVING COUNT(*) > 200 等）、時間窗與排除條件，在此用真實資料驗證。
 * 但「ok／warning／critical」的狀態分類寫在 agent 的 JS 裡，無法在 api repo 不 vendoring agent 程式碼下測，
 * 刻意略過（由 agent repo 自己的測試守）；不為湊數量而重寫一份分類邏輯。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createD1 } from '../support/d1';
import { contract, sqlOf } from './helpers';

let d1: ReturnType<typeof createD1>;
beforeEach(() => {
  d1 = createD1();
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u-1', 'u1@example.com')").run();   // audit_log.changed_by_user_id 有外鍵
});
afterEach(() => d1.close());

const rows = (sql: string, ...bind: unknown[]) => d1.raw.prepare(sql).all(...(bind as never[])) as Array<Record<string, unknown>>;

describe('快照內每條 SQL 都能在現行 schema 上 prepare 並執行', () => {
  it('快照不是空的（防止匯出壞掉卻全綠）', () => {
    expect(contract.dailyCheckSql.length).toBeGreaterThanOrEqual(4);
    expect(contract.dailyCheckSql.flatMap((s) => s.sql).length).toBeGreaterThanOrEqual(6);
  });

  for (const entry of contract.dailyCheckSql) {
    entry.sql.forEach((sql, i) => {
      it(`${entry.source}[${i}]`, () => {
        // 以 null 綁定所有 ? 佔位（目前快照沒有佔位；日後有也不會因綁定數不符誤報）
        const binds = Array<null>((sql.match(/\?/g) ?? []).length).fill(null);
        expect(() => rows(sql, ...binds), 'SQL 與現行 migration schema 不一致（no such table／column）').not.toThrow();
      });
    });
  }

  it('有 skipped 標記的來源要有人看過：目前快照不應出現', () => {
    expect(contract.dailyCheckSql.filter((s) => s.skipped)).toEqual([]);
  });
});

describe('auditAnomaly 的門檻與時間窗（SQL 層）', () => {
  const heavyUsers = () => rows(sqlOf('auditAnomaly', 0));
  const heavyTrips = () => rows(sqlOf('auditAnomaly', 1));
  const deletes = () => rows(sqlOf('auditAnomaly', 2));

  function addAudit(n: number, o: { trip?: string; table?: string; action?: string; userId?: string | null; ago?: string } = {}) {
    const stmt = d1.raw.prepare(
      `INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, changed_by_user_id, created_at)
       VALUES (?, ?, 1, ?, 'x', ?, datetime('now', ?))`,
    );
    for (let i = 0; i < n; i++) stmt.run(o.trip ?? 't-1', o.table ?? 'trip_entries', o.action ?? 'update', o.userId === undefined ? 'u-1' : o.userId, o.ago ?? '-0 day');
  }

  it('使用者門檻是「大於 200」：剛好 200 不算，201 才回該使用者', () => {
    addAudit(200, { trip: 'system' });
    expect(heavyUsers()).toHaveLength(0);
    addAudit(1, { trip: 'system' });
    expect(heavyUsers()).toHaveLength(1);
    expect(heavyUsers()[0]).toMatchObject({ userId: 'u-1', mutations: 201 });
  });

  it('沒有 user id 的紀錄（service token）不計入使用者門檻', () => {
    addAudit(201, { trip: 'system', userId: null });
    expect(heavyUsers()).toHaveLength(0);
  });

  it('trip 門檻是「大於 100」，且 system trip 不計；service token 也算', () => {
    addAudit(100, { trip: 't-edge', userId: null });
    expect(heavyTrips()).toHaveLength(0);
    addAudit(1, { trip: 't-edge', userId: null });
    expect(heavyTrips().map((r) => r.tripId)).toEqual(['t-edge']);
    addAudit(500, { trip: 'system', userId: null });
    expect(heavyTrips().map((r) => r.tripId)).toEqual(['t-edge']);
  });

  it('heavyTrips 最多 10 筆（LIMIT 10）', () => {
    for (let i = 0; i < 12; i++) addAudit(101, { trip: `t-lim-${i}`, userId: null });
    expect(heavyTrips()).toHaveLength(10);
  });

  it('trips／users 表的 delete「大於 10」才回；剛好 10 不算；其他表與其他動作不算', () => {
    addAudit(10, { table: 'trips', action: 'delete', trip: 'system' });
    expect(deletes()).toHaveLength(0);
    addAudit(1, { table: 'trips', action: 'delete', trip: 'system' });
    expect(deletes()).toEqual([expect.objectContaining({ tableName: 'trips', deletes: 11 })]);
    addAudit(50, { table: 'trip_entries', action: 'delete' });
    addAudit(50, { table: 'users', action: 'update' });
    expect(deletes()).toHaveLength(1);
    addAudit(11, { table: 'users', action: 'delete', trip: 'system' });
    expect(deletes().map((r) => r.tableName).sort()).toEqual(['trips', 'users']);
  });

  it('24 小時窗口兩側：23 小時前算、25 小時前不算（三條查詢皆然）', () => {
    addAudit(201, { trip: 't-old', ago: '-25 hours' });
    addAudit(11, { table: 'trips', action: 'delete', trip: 'system', ago: '-25 hours' });
    expect([heavyUsers(), heavyTrips(), deletes()].map((r) => r.length)).toEqual([0, 0, 0]);
    addAudit(201, { trip: 't-new', ago: '-23 hours' });
    addAudit(11, { table: 'trips', action: 'delete', trip: 'system', ago: '-23 hours' });
    expect(heavyUsers()).toHaveLength(1);
    expect(heavyTrips().map((r) => r.tripId)).toEqual(['t-new']);
    expect(deletes()).toHaveLength(1);
  });
});

describe('dataHygiene（migration 0078 DROP trip_entries.note 之後）', () => {
  const run = () => rows(sqlOf('dataHygiene'));

  function seedEntry(description: string | null) {
    d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u-h', 'h@example.com')").run();
    d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id) VALUES ('t-hyg', 'hyg', 'u-h')").run();
    const day = d1.raw.prepare("INSERT INTO trip_days (trip_id, day_num) VALUES ('t-hyg', 1)").run();
    return Number(d1.raw.prepare('INSERT INTO trip_entries (day_id, sort_order, description) VALUES (?, 1, ?)').run(day.lastInsertRowid, description).lastInsertRowid);
  }
  const poi = (name: string) => Number(d1.raw.prepare("INSERT INTO pois (name, type) VALUES (?, 'attraction')").run(name).lastInsertRowid);

  it('乾淨資料 → 無列', () => {
    seedEntry('一般說明');
    expect(run()).toHaveLength(0);
  });

  it('entry 說明含測試標記 → 回該列，帶 trip_id／day_num', () => {
    seedEntry('這個是 __TEST_ONLY__ 殘留');
    expect(run()).toEqual([expect.objectContaining({ trip_id: 't-hyg', day_num: 1 })]);
  });

  it('master POI（sort_order=1）的備註含標記 → 被掃到；備選 POI（sort_order=2）的備註不掃', () => {
    const entryId = seedEntry(null);
    const ins = d1.raw.prepare('INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, note) VALUES (?, ?, ?, ?)');
    ins.run(entryId, poi('p2'), 2, 'AUTO_TEST_FIXTURE');
    expect(run()).toHaveLength(0);
    ins.run(entryId, poi('p1'), 1, 'AUTO_TEST_FIXTURE');
    expect(run()).toEqual([expect.objectContaining({ note: 'AUTO_TEST_FIXTURE' })]);
  });

  it('沒有 POI 的 entry 仍能靠 description 命中（LEFT JOIN）', () => {
    seedEntry('TEST_AUTO_UPDATE_PROBE');
    expect(run()).toHaveLength(1);
  });
});

describe('requestErrors 的排除條件', () => {
  const run = () => rows(sqlOf('requestErrors'));
  const add = (status: string, o: { reason?: string | null; created?: string; updated?: string | null } = {}) =>
    d1.raw.prepare(`INSERT INTO trip_requests (trip_id, message, status, terminal_reason, created_at, updated_at)
      VALUES ('t', 'm', ?, ?, datetime('now', ?), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`)
      .run(status, o.reason ?? null, o.created ?? '-1 hours', o.updated ?? null, o.updated ?? '0 seconds');

  it('completed 不算；open／processing／failed 都回', () => {
    add('completed'); add('open'); add('processing'); add('failed');
    expect(run().map((r) => r.status).sort()).toEqual(['failed', 'open', 'processing']);
  });

  it('超過 24 小時的陳年請求不回', () => {
    add('failed', { created: '-25 hours' });
    expect(run()).toHaveLength(0);
  });

  it('15 分鐘內取消的 failed 不算；等滿 15 分鐘才取消、或 terminal_reason 為 NULL 的照報', () => {
    add('failed', { reason: 'cancelled', created: '-60 minutes', updated: '-55 minutes' });   // 5 分鐘內取消 → 排除
    expect(run()).toHaveLength(0);
    add('failed', { reason: 'cancelled', created: '-60 minutes', updated: '-30 minutes' });   // 30 分鐘才取消 → 照報
    add('failed', { reason: null, created: '-60 minutes', updated: '-55 minutes' });          // NULL → 照報
    expect(run()).toHaveLength(2);
  });

  it('只認 status=failed 的取消：processing 單帶 cancelled 仍照報', () => {
    add('processing', { reason: 'cancelled', created: '-60 minutes', updated: '-55 minutes' });
    expect(run()).toHaveLength(1);
  });
});

describe('apiErrors 的過濾', () => {
  const run = () => rows(sqlOf('apiErrors'));
  const add = (status: number, p: string, o: { error?: string | null; source?: string | null; method?: string } = {}) =>
    d1.raw.prepare("INSERT INTO api_logs (method, path, status, error, source) VALUES (?, ?, ?, ?, ?)")
      .run(o.method ?? 'GET', p, status, o.error ?? null, o.source ?? null);

  it('401／403／429 與 < 400 不計；其餘 4xx／5xx 依 path+method+status 分組計數', () => {
    add(200, '/a'); add(401, '/a'); add(403, '/a'); add(429, '/a');
    expect(run()).toHaveLength(0);
    add(500, '/b'); add(500, '/b'); add(400, '/c');
    expect(run()).toEqual([
      expect.objectContaining({ path: '/b', status: 500, count: 2 }),
      expect.objectContaining({ path: '/c', status: 400, count: 1 }),
    ]);
  });

  it('可預期的雜訊被排除：docs 404、anonymous 405、/api/route 空結果 502', () => {
    add(404, '/api/trips/t1/docs/checklist');
    add(405, '/api/oauth/introspect', { source: 'anonymous', method: 'POST' });
    add(502, '/api/route', { error: 'MAPS_UPSTREAM_FAILED: Routes empty result' });
    expect(run()).toHaveLength(0);
  });

  it('同路徑但不是預期情形的仍照報：一般 404、已登入的 405、/api/route 其他 502', () => {
    add(404, '/api/trips/t1/entries/9');
    add(405, '/api/x', { source: 'user' });
    add(502, '/api/route', { error: 'MAPS_UPSTREAM_FAILED: timeout' });
    expect(run()).toHaveLength(3);
  });

  it('24 小時窗口：25 小時前的不算', () => {
    d1.raw.prepare("INSERT INTO api_logs (method, path, status, created_at) VALUES ('GET', '/old', 500, datetime('now', '-25 hours'))").run();
    expect(run()).toHaveLength(0);
  });
});
