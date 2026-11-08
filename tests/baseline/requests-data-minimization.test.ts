/**
 * GET /api/requests：對服務 token 與 restrict_trip token 省略 submittedBy（email），一般使用者不變（spec #1553 的資料最小化，
 * 與 AI 資料同意功能無關，同意功能移除後保留）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';
import { cleanupTrips } from './cleanup-trips';
import { ApiError } from '../../src/schemas/common';
import { expectContract } from '../contract/support';

const OWNER = 'rdm-owner@test.com';
const TRIP = 'rdm-trip';

let db: D1Database;
let apiOn: Api;

beforeAll(async () => {
  db = await createTestDb();
  apiOn = createApi({ env: mockEnv(db, {}) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
});

afterAll(async () => {
  await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('GET /api/requests：對服務 token 省略 submittedBy（email）', () => {
  let svc: string;
  let reqId: number;
  beforeAll(async () => {
    svc = await serviceToken(db, ['ops:trips:read', 'companion']);
    reqId = (await db.prepare("INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, 'min-1', ?) RETURNING id").bind(TRIP, OWNER).first<{ id: number }>())!.id;
  });
  it('服務 token：列表（陣列與分頁兩種形狀）沒有 submittedBy，仍有 submittedByDisplayName', async () => {
    // 服務 token 不能帶 tripId 讀（hasPermission 對服務 token 恆 false）；走 ops:trips:read 的全域列表
    const arr = await (await apiOn.request('GET', '/api/requests', { bearer: svc })).json() as Array<Record<string, unknown>>;
    expect(arr.length).toBeGreaterThan(0);
    for (const r of arr) { expect(r).not.toHaveProperty('submittedBy'); expect(r).toHaveProperty('submittedByDisplayName'); }
    const noTrip = await (await apiOn.request('GET', '/api/requests?limit=50', { bearer: svc })).json() as { items: Array<Record<string, unknown>> };
    expect(noTrip.items.length).toBeGreaterThan(0);
    for (const r of noTrip.items) expect(r).not.toHaveProperty('submittedBy');
    expect(JSON.stringify(arr)).not.toContain('@test.com');
  });
  it('一般使用者：回應完全不變（仍含 submittedBy 與 submittedByDisplayName）', async () => {
    const arr = await (await apiOn.get(`/api/requests?tripId=${TRIP}`, { as: OWNER })).json() as Array<Record<string, unknown>>;
    const mine = arr.find((r) => r.id === reqId)!;
    expect(mine.submittedBy).toBe(OWNER);
    expect(mine.submittedByDisplayName).toBe(OWNER.split('@')[0]);
    const one = await (await apiOn.get(`/api/requests/${reqId}`, { as: OWNER })).json() as Record<string, unknown>;
    expect(one.submittedBy).toBe(OWNER);
    expect(one.submittedByDisplayName).toBe(OWNER.split('@')[0]);
  });
  it('restrict_trip 的使用者 token（agent 的 MCP 實際用的）：列表與單筆都沒有 submittedBy，仍有 submittedByDisplayName', async () => {
    const restricted = await apiOn.tokenFor(OWNER, ['trips:read', 'trips:write'], { restrictTrip: TRIP });
    const arr = await (await apiOn.request('GET', `/api/requests?tripId=${TRIP}`, { bearer: restricted })).json() as Array<Record<string, unknown>>;
    expect(arr.length).toBeGreaterThan(0);
    for (const r of arr) { expect(r).not.toHaveProperty('submittedBy'); expect(r).toHaveProperty('submittedByDisplayName'); }
    const page = await (await apiOn.request('GET', `/api/requests?tripId=${TRIP}&limit=50`, { bearer: restricted })).json() as { items: Array<Record<string, unknown>> };
    for (const r of page.items) expect(r).not.toHaveProperty('submittedBy');
    const one = await apiOn.request('GET', `/api/requests/${reqId}`, { bearer: restricted });
    expect(one.status).toBe(200);
    const ob = await one.json() as Record<string, unknown>;
    expect(ob).not.toHaveProperty('submittedBy');
    expect(ob.submittedByDisplayName).toBe(OWNER.split('@')[0]);
    expect(JSON.stringify([arr, page, ob])).not.toContain('@test.com');
  });
  it('GET /api/requests/:id 對服務 token 仍是 403（沒有任何 email 外洩路徑）', async () => {
    const res = await apiOn.request('GET', `/api/requests/${reqId}`, { bearer: svc });
    expect(res.status).toBe(403);
    expectContract(ApiError, await res.json());
  });
});

