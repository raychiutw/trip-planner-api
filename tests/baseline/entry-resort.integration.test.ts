// @vitest-environment node
/**
 * resortDayByArrival — 依抵達時間（start_time）升冪重排某日 sort_order。
 *
 * 觸發於互動改時間 / 新增景點；手動拖曳與 bulk 建立不經過。這裡走 HTTP 邊界驗端點層級的觸發條件；
 * helper 本身的排序行為（亂序、no-op、stable、少於 2 筆）在 tests/unit/entry-resort-module.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { seedTrip, getDayId, mockEnv } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
const OWNER = 'entry-resort-owner@test.com';
const tripIds: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
}, 30000);

afterAll(async () => {
  // 共用 D1：只清自己建立的行程（days / entries 走 FK cascade，permissions 要手動清）
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

/** 插入 entry，顯式指定 sort_order + start_time（null / '' 允許）。 */
async function ins(dayId: number, sortOrder: number, startTime: string | null): Promise<number> {
  const r = await db
    .prepare('INSERT INTO trip_entries (day_id, sort_order, start_time) VALUES (?, ?, ?) RETURNING id')
    .bind(dayId, sortOrder, startTime)
    .first<{ id: number }>();
  return r!.id;
}

async function idsInOrder(dayId: number): Promise<number[]> {
  const { results } = await db
    .prepare('SELECT id FROM trip_entries WHERE day_id = ? ORDER BY sort_order ASC')
    .bind(dayId)
    .all<{ id: number }>();
  return (results ?? []).map((r) => r.id);
}

describe('PATCH /entries/:eid resort guard — 端點層級：改 start_time 觸發、其他不觸發', () => {
  const TRIP = 'resort-ep-trip';
  let api: Api;

  beforeAll(async () => {
    api = createApi({ env: mockEnv(db) });
    tripIds.push(TRIP);
    await seedTrip(db, { id: TRIP, days: 4, owner: OWNER });
  }, 30000);

  // 走 HTTP 邊界（tests/api/http.ts）
  function patch(eid: number, body: Record<string, unknown>) {
    return api.request('PATCH', `/api/trips/${TRIP}/entries/${eid}`, { as: OWNER, json: body });
  }

  it('(a) PATCH { start_time } → 當日依抵達時間重排', async () => {
    const dayId = await getDayId(db, TRIP, 1);
    const e14 = await ins(dayId, 0, '14:00');
    const e09 = await ins(dayId, 1, '09:00');
    const e11 = await ins(dayId, 2, '11:00');
    const resp = await patch(e14, { start_time: '08:00' });
    expect(resp.status).toBe(200);
    expect(await idsInOrder(dayId)).toEqual([e14, e09, e11]); // 08:00 → 09:00 → 11:00
  });

  it('(b) PATCH { end_time } only → 不重排（亂序保持不變）', async () => {
    const dayId = await getDayId(db, TRIP, 2);
    const a = await ins(dayId, 0, '14:00'); // 故意亂序：14:00 在前
    const b = await ins(dayId, 1, '09:00');
    const before = await idsInOrder(dayId); // [a, b]
    const resp = await patch(a, { end_time: '23:00' });
    expect(resp.status).toBe(200);
    expect(await idsInOrder(dayId)).toEqual(before); // 只改 end_time → 不觸發重排
  });

  it('(c) PATCH { start_time, sort_order } → 顯式 sort_order 優先、跳過重排', async () => {
    const dayId = await getDayId(db, TRIP, 3);
    const a = await ins(dayId, 0, '14:00');
    const b = await ins(dayId, 1, '09:00');
    // a 改最早 00:01 但同時顯式 sort_order=5 → 若重排會排最前；跳過則依 sort_order 殿後。
    const resp = await patch(a, { start_time: '00:01', sort_order: 5 });
    expect(resp.status).toBe(200);
    const order = await idsInOrder(dayId);
    expect(order[order.length - 1]).toBe(a); // 尊重顯式 sort_order，未被重排到最前
    void b;
  });
});
