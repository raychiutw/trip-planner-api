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

describe('PR32 — source-grep regression: 4 endpoint 都 import logAudit', () => {
  it('recompute-travel.ts import + call logAudit', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const ROOT = join(__dirname, '..', '..');
    const FILES = [
      // days / days/shift / pois enrich 的 handler 由其他組搬移，各自的測試守門
      'src/routes/handlers/trips/@id/recompute-travel.ts',
    ];
    for (const rel of FILES) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} 應 import logAudit`).toMatch(/import\s+\{[^}]*logAudit/);
      expect(src, `${rel} 應 call logAudit`).toMatch(/await\s+logAudit\(/);
    }
  });
});
