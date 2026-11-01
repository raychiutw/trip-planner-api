/**
 * Integration test — service-token attribution + auth guards (v2.21.0 MF7)
 *
 * 走 HTTP 邊界：真實 bearer（user_id 為 null 的服務 token）→ middleware 辨識 → handler。
 *
 * 驗證：
 *  - 服務 token 即使帶 trips:read / trips:write，也讀不到 / 寫不了非公開行程（無 admin bypass，
 *    維運靠 ops scope 不靠 trip membership）。
 *  - 使用者 token 仍依 trip_permissions 授權（owner 可、陌生人不可）。
 *  - 稽核歸屬：服務 token 的寫入記為 `service:${client_id}`，不繼承 ADMIN_EMAIL。
 *
 * 原本「帶偽造 userId 的 mockServiceAuth 直接呼叫 hasPermission」那條，經 middleware 不可能產生
 * （只有 user_id 為 null 的 token 才會被辨識成服務 token），保留成直接呼叫、集中在檔尾（待 #1503）。
 * 原本「手動 INSERT audit_log 再讀回來」的兩條稽核歸屬測試只是在測 INSERT 本身，改成真實的寫入請求。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, seedPoi } from './helpers';
import { createApi, type Api } from './http';
import { serviceTokenFor } from './service-token';
import { cleanupTrips } from './cleanup-trips';
import type { Env } from '../../src/env';

let db: D1Database;
let api: Api;
const TRIP = 'mw-svc-trip';
const OWNER = 'mw-svc-owner@test.com';
const STRANGER = 'mw-svc-stranger@test.com';
const poiIds: number[] = [];

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ADMIN_EMAIL: 'admin@test.com' } as Partial<Env>) });
  // 非公開行程，讓授權判斷只能靠 trip_permissions
  await seedTrip(db, { id: TRIP, owner: OWNER, published: 0 });
  await seedUser(db, STRANGER);
});

afterAll(async () => {
  for (const id of poiIds) {
    await db.prepare("DELETE FROM audit_log WHERE table_name = 'pois' AND record_id = ?").bind(id).run();
  }
  await cleanupTrips(db, [TRIP], ['mw-svc-poi%']);
  await disposeMiniflare();
});

async function tripExists(): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM trips WHERE id = ?').bind(TRIP).first());
}

describe('service-token auth guards (MF7)', () => {
  it('service token → 讀寫非公開行程皆被拒（Phase 3：無 admin bypass，維運靠 ops scope 不靠 trip membership）', async () => {
    const token = await serviceTokenFor(db, {
      clientId: 'svc-admin-1',
      scopes: ['ops:trips:read', 'trips:read', 'trips:write'],
    });
    const read = await api.get(`https://test.com/api/trips/${TRIP}`, { bearer: token });
    expect(read.status).toBe(403);
    const write = await api.request('DELETE', `https://test.com/api/trips/${TRIP}`, { bearer: token });
    expect(write.status).toBe(403);
    expect(await tripExists()).toBe(true);
  });

  it('non-admin scope service token → 讀寫皆被拒 (defense-in-depth)', async () => {
    const token = await serviceTokenFor(db, { clientId: 'svc-readonly-1', scopes: ['read'] });
    const read = await api.get(`https://test.com/api/trips/${TRIP}`, { bearer: token });
    expect(read.status).toBe(403);
    const write = await api.request('DELETE', `https://test.com/api/trips/${TRIP}`, { bearer: token });
    expect(write.status).toBe(403);
    expect(await tripExists()).toBe(true);
  });

  it('non-admin scope service token 無法靠 trip_permissions 裡別人的 row 提權', async () => {
    // 即使某個 user_id 在該行程有 member 權限列，服務 token（user_id 為 null）也借用不到
    const ghostUserId = 'ghost-user';
    await db.prepare(
      'INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)'
    ).bind(ghostUserId, 'ghost@test.com', 'ghost').run();
    await db.prepare(
      'INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, ?)'
    ).bind(ghostUserId, TRIP, 'member').run();

    const svc = await serviceTokenFor(db, { clientId: 'svc-ghost-1', scopes: ['trips:read', 'trips:write'] });
    const read = await api.get(`https://test.com/api/trips/${TRIP}`, { bearer: svc });
    expect(read.status).toBe(403);
    const write = await api.request('DELETE', `https://test.com/api/trips/${TRIP}`, { bearer: svc });
    expect(write.status).toBe(403);
    expect(await tripExists()).toBe(true);
  });

  it('user session (not service token) still gates by trip_permissions', async () => {
    const owner = await api.get(`https://test.com/api/trips/${TRIP}`, { as: OWNER });
    expect(owner.status).toBe(200);
    // stranger 沒有 trip_permissions row
    const stranger = await api.get(`https://test.com/api/trips/${TRIP}`, { as: STRANGER });
    expect(stranger.status).toBe(403);
  });
});

describe('audit attribution sentinel (MF7)', () => {
  async function patchPoiAs(clientId: string): Promise<{ poiId: number; status: number }> {
    const poiId = await seedPoi(db, { name: `mw-svc-poi-${clientId}` });
    poiIds.push(poiId);
    const token = await serviceTokenFor(db, { clientId, scopes: ['ops:poi'] });
    const res = await api.request('PATCH', `https://test.com/api/pois/${poiId}`, {
      bearer: token,
      json: { name: `mw-svc-poi-renamed-${clientId}` },
    });
    return { poiId, status: res.status };
  }

  async function changedBy(poiId: number): Promise<string | undefined> {
    const row = await db
      .prepare("SELECT changed_by FROM audit_log WHERE table_name = 'pois' AND record_id = ? ORDER BY id DESC LIMIT 1")
      .bind(poiId)
      .first<{ changed_by: string }>();
    return row?.changed_by;
  }

  it('service token write logs `service:${clientId}` not admin email', async () => {
    const { poiId, status } = await patchPoiAs('svc-attribution-1');
    expect(status).toBe(200);
    const by = await changedBy(poiId);
    expect(by).toBe('service:svc-attribution-1');
    expect(by).not.toBe('admin@test.com');
  });

  it('ops scope service token 也不繼承 ADMIN_EMAIL（env 有設 ADMIN_EMAIL 仍記 service sentinel）', async () => {
    const { poiId, status } = await patchPoiAs('svc-ops-attribution-2');
    expect(status).toBe(200);
    const by = await changedBy(poiId);
    expect(by).toBe('service:svc-ops-attribution-2');
    expect(by).not.toBe('admin@test.com');
  });
});
