/**
 * Integration test — v2.34.32 PR32 audit_log coverage
 *
 * 4 個 mutation endpoint 補 logAudit：
 *   - POST /api/trips/:id/days → action='insert' + recordId=newDayId
 *   - POST /api/trips/:id/days/shift → action='update' + recordId=null + op:'shift'
 *   - POST /api/trips/:id/recompute-travel → action='update' + recordId=null + op:'recompute-travel'
 *   - POST /api/pois/:id/enrich → action='update' + recordId=poiId + op:'enrich'
 *
 * 對齊 entries / segments / trip-notes (PR26/27) 既有 pattern。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

// 走 HTTP 邊界（tests/api/http.ts）；共用 D1 用 s16- 專屬 trip id／owner，結束時清掉自己的資料
const OWNER = 's16-pr32-owner@test.com';
const TRIPS = ['s16-pr32-days-trip', 's16-pr32-shift-trip', 's16-pr32-shift-noop'];

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(async () => {
  for (const id of TRIPS) await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(id).run();
  await cleanupTrips(db, TRIPS);
  await disposeMiniflare();
});

async function fetchAuditRows(tripId: string, tableName: string) {
  const rs = await db
    .prepare(
      `SELECT action, table_name AS tableName, record_id AS recordId, changed_by AS changedBy, diff_json AS diffJson
       FROM audit_log WHERE trip_id = ? AND table_name = ? ORDER BY id ASC`,
    )
    .bind(tripId, tableName)
    .all<{ action: string; tableName: string; recordId: number | null; changedBy: string; diffJson: string }>();
  return rs.results ?? [];
}

describe('PR32 — POST /api/trips/:id/days 補 audit_log', () => {
  it('append 新天 → audit_log action=insert + recordId 為新 day id', async () => {
    const tripId = TRIPS[0]!;
    await seedTrip(db, { id: tripId, days: 2, owner: OWNER });
    const before = await fetchAuditRows(tripId, 'trip_days');

    const res = await api.request('POST', `/api/trips/${tripId}/days`, { as: OWNER, json: { position: 'end' } });
    expect(res.status).toBe(200);

    const after = await fetchAuditRows(tripId, 'trip_days');
    expect(after.length).toBe(before.length + 1);
    const last = after[after.length - 1];
    expect(last.action).toBe('insert');
    expect(last.recordId).toBeGreaterThan(0);
    expect(last.diffJson).toContain('day_num');
    expect(last.changedBy).toBe(OWNER);
  });

  // mutation 驗證補的缺口：被拒絕的寫入不得留下稽核
  it('非 owner 新增天 → 403，不新增天也不寫 audit_log', async () => {
    const tripId = TRIPS[0]!;
    const before = await fetchAuditRows(tripId, 'trip_days');
    const res = await api.request('POST', `/api/trips/${tripId}/days`, { as: 's16-pr32-stranger@test.com', json: { position: 'end' } });
    expect(res.status).toBe(403);
    expect(await fetchAuditRows(tripId, 'trip_days')).toHaveLength(before.length);
  });
});

describe('PR32 — POST /api/trips/:id/days/shift 補 audit_log', () => {
  it('shift +3d → audit_log action=update + recordId=null + op:shift summary', async () => {
    const tripId = TRIPS[1]!;
    await seedTrip(db, { id: tripId, days: 3, owner: OWNER });

    const res = await api.request('POST', `/api/trips/${tripId}/days/shift`, { as: OWNER, json: { startDate: '2026-04-04' } });
    expect(res.status).toBe(200);

    const audits = await fetchAuditRows(tripId, 'trip_days');
    // 最新一筆應是 shift（之前可能有 POST insert 留下的，這裡找 op:shift）
    const shifts = audits.filter((a) => a.diffJson.includes('"op":"shift"'));
    expect(shifts.length).toBeGreaterThanOrEqual(1);
    const shiftAudit = shifts[shifts.length - 1];
    expect(shiftAudit.action).toBe('update');
    expect(shiftAudit.recordId).toBeNull();
    expect(shiftAudit.diffJson).toContain('"deltaDays":3');
    expect(shiftAudit.diffJson).toContain('"daysShifted":3');
    expect(shiftAudit.changedBy).toBe(OWNER);
  });

  it('shift delta=0 → 早 return 不寫 audit', async () => {
    const tripId = TRIPS[2]!;
    await seedTrip(db, { id: tripId, days: 2, owner: OWNER });
    const before = await fetchAuditRows(tripId, 'trip_days');

    const res = await api.request('POST', `/api/trips/${tripId}/days/shift`, { as: OWNER, json: { startDate: '2026-04-01' } });
    expect(res.status).toBe(200);

    const after = await fetchAuditRows(tripId, 'trip_days');
    expect(after.length).toBe(before.length); // delta=0 早 return 不寫 audit
  });
});

describe('PR32 — source-grep regression: 4 endpoint 都 import logAudit', () => {
  it('days.ts / days/shift.ts / recompute-travel.ts / pois/[id]/enrich.ts 都 import + call logAudit', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const ROOT = join(__dirname, '..', '..');
    const FILES = [
      'functions/api/trips/[id]/days.ts',
      'functions/api/trips/[id]/days/shift.ts',
      'functions/api/trips/[id]/recompute-travel.ts',
      'functions/api/pois/[id]/enrich.ts',
    ];
    for (const rel of FILES) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} 應 import logAudit`).toMatch(/import\s+\{[^}]*logAudit/);
      expect(src, `${rel} 應 call logAudit`).toMatch(/await\s+logAudit\(/);
    }
  });
});
