/**
 * GET /api/trips/:id/ai-authorization — 旅伴送出前查「行程擁有者是否已授權 AI」（#1600）。
 * 簽發 token 查的是擁有者的 Consent，所以這裡查的也是擁有者，不是登入者。
 * 只回兩個布林：ownerAuthorized（擁有者是否授權）、isOwner（登入者是否就是擁有者）；僅限對該行程有權限者。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const OWNER = 'tai-owner@test.com';
const MEMBER = 'tai-member@test.com';
const STRANGER = 'tai-stranger@test.com';
const TRIP = 'tai-trip';
const CLIENT = 'tripline-tp-request';
let db: D1Database;
let api: Api;
let ownerUid: string;
let memberUid: string;

const get = (as?: string) => api.get(`/api/trips/${TRIP}/ai-authorization`, as ? { as } : {});
const setOwnerConsent = (on: boolean) => on
  ? new D1Adapter(db, 'Consent').upsert(`${ownerUid}:${CLIENT}`, { user_id: ownerUid, client_id: CLIENT, scopes: [], grantedAt: 1 }, 300)
  : db.prepare("DELETE FROM oauth_models WHERE name = 'Consent' AND id = ?").bind(`${ownerUid}:${CLIENT}`).run();

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  ownerUid = (await seedTrip(db, { id: TRIP, owner: OWNER, published: 0 })).ownerUserId;
  memberUid = `test-user-${MEMBER.replace(/[^a-z0-9]/gi, '-')}`;
  await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(memberUid, MEMBER, 'm').run();
  await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'member')").bind(memberUid, TRIP).run();
  // 陌生人的使用者資料列由 http helper 的 as 建立
}, 30000);

afterAll(async () => {
  await setOwnerConsent(false);
  await cleanupTrips(db, ['tai-%']);
  await disposeMiniflare();
});

describe('GET /api/trips/:id/ai-authorization', () => {
  it('擁有者已授權：擁有者本人與旅伴都看到 ownerAuthorized:true', async () => {
    await setOwnerConsent(true);
    expect(await (await get(OWNER)).json()).toEqual({ ownerAuthorized: true, isOwner: true });
    expect(await (await get(MEMBER)).json()).toEqual({ ownerAuthorized: true, isOwner: false });
  });

  it('擁有者未授權：旅伴看到 ownerAuthorized:false（即使旅伴自己授權過也一樣）', async () => {
    await setOwnerConsent(false);
    await new D1Adapter(db, 'Consent').upsert(`${memberUid}:${CLIENT}`, { user_id: memberUid, client_id: CLIENT, scopes: [], grantedAt: 1 }, 300);
    const res = await get(MEMBER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ownerAuthorized: false, isOwner: false });
    await db.prepare("DELETE FROM oauth_models WHERE name = 'Consent' AND id = ?").bind(`${memberUid}:${CLIENT}`).run();
  });

  it('非成員 403、未登入 401，且不洩漏授權狀態', async () => {
    await setOwnerConsent(true);
    const denied = await get(STRANGER);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain('ownerAuthorized');
    expect((await get()).status).toBe(401);
  });
});
