/**
 * Integration test — GET /api/trips/:id/audit
 * 走 HTTP 邊界（tests/api/http.ts），以真實 bearer token 認證；共用 D1 用 s16- 專屬 id／email。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

const TRIP = 's16-audit-trip';
const OWNER = 's16-audit-owner@test.com';
const STRANGER = 's16-audit-stranger@test.com';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
  // 插入 audit log
  await db.prepare(
    'INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, diff_json) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(TRIP, 'trips', 1, 'update', 'admin@test.com', '{"title":{"old":"a","new":"b"}}').run();
});

afterAll(async () => {
  await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('GET /api/trips/:id/audit', () => {
  it('owner 取得 audit log', async () => {
    const resp = await api.get(`/api/trips/${TRIP}/audit`, { as: OWNER }); // owner（D4：audit 改 owner gate）
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]!.action).toBe('update');
  });

  it('非 owner（無 trip 寫權限）→ 403', async () => {
    expect((await api.get(`/api/trips/${TRIP}/audit`, { as: STRANGER })).status).toBe(403);
  });

  it('未認證 → 401', async () => {
    expect((await api.get(`/api/trips/${TRIP}/audit`)).status).toBe(401);
  });
});
