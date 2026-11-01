import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';

const OWNER = 'day-replace-owner@test.com';
let db: D1Database;
let api: Api;
const tripIds: string[] = [];
beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});
afterAll(async () => {
  // 共用 D1：只清自己建立的行程（days / entries 等子表走 FK cascade，permissions 要手動清）
  for (const id of tripIds) {
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(id).run(); // 無 FK cascade
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

/** 建立行程並記下 id，afterAll 清掉。 */
async function seed(tripId: string) {
  tripIds.push(tripId);
  await seedTrip(db, { id: tripId, days: 1, owner: OWNER });
}
/** requestApi 預設用正常的 api；注入故障時傳入故障 D1 包成的 api。 */
function put(tripId: string, body: unknown, requestApi: Api = api) {
  return requestApi.request('PUT', `/api/trips/${tripId}/days/1`, { as: OWNER, json: body });
}
async function read(tripId: string) {
  const response = await api.get(`/api/trips/${tripId}/days/1`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ version: number; timeline: Array<Record<string, unknown>> }>;
}
function replacement(prefix: string, count = 2) {
  return { date: '2026-09-22', dayOfWeek: '二', label: prefix,
    hotel: { name: `${prefix}飯店`, parking: [{ name: `${prefix}停車場` }] },
    timeline: Array.from({ length: count }, (_, i) => ({ time: '09:00', stopPois: [
      { name: `${prefix}景點${i}`, type: 'attraction', note: '正選備註', reservation: '已預訂', reservationUrl: 'https://example.com/master' },
      { name: `${prefix}備選${i}`, type: 'restaurant', note: '備選備註', reservation: '待確認', reservationUrl: 'https://example.com/alt' },
    ] })),
  };
}
/** 在真 D1 batch 執行時拋錯，讓 SQLite 自己決定哪些寫入回滾。 */
function failStatement(match: RegExp, occurrence = 1): D1Database {
  let seen = 0;
  return new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => {
      if (match.test(sql) && ++seen === occurrence) {
        const failure = target.prepare('SELECT json(?)').bind('injected-invalid-json');
        return new Proxy(failure, { get(stmt, member) {
          if (member === 'bind') return () => failure;
          const value = Reflect.get(stmt, member);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      }
      return target.prepare(sql);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** 以「會在指定 SQL 上拋錯」的 D1 建一個進程內 api；寫入仍走真實 D1，由 SQLite 決定哪些回滾。 */
function failingApi(match: RegExp, occurrence = 1): Api {
  return createApi({ env: mockEnv(failStatement(match, occurrence)) });
}

describe('整天替換的完整性', () => {
  it.each([
    { phase: 'entry', sql: /INSERT INTO trip_entries/, occurrence: 2, count: 2 },
    { phase: 'hotel', sql: /UPDATE trip_days SET hotel_poi_id/, occurrence: 1, count: 2 },
    { phase: 'parking', sql: /INSERT.*INTO poi_relations/, occurrence: 1, count: 2 },
    { phase: 'large', sql: /INSERT.*INTO trip_entry_pois/, occurrence: 101, count: 60 },
  ])('$phase 階段失敗仍完整保留 $count 筆舊 entry，重試得到完整新 day', async ({ phase, sql, occurrence, count }) => {
    const tripId = `replace-phase-${phase}`;
    await seed(tripId);
    expect((await put(tripId, replacement('原子舊', count))).status).toBe(200);
    const before = await read(tripId);
    expect(before.timeline).toHaveLength(count);
    expect((await put(tripId, replacement('原子新', count), failingApi(sql, occurrence))).status).toBe(500);
    expect(await read(tripId)).toEqual(before);
    expect((await put(tripId, replacement('原子新', count))).status).toBe(200);
    const after = await read(tripId);
    expect(after.version).toBe(2);
    expect(after.timeline).toHaveLength(count);
    expect(after.timeline.at(-1)).toMatchObject({ master: { name: `原子新景點${count - 1}` }, alternates: [{ name: `原子新備選${count - 1}` }] });
  });

  it('備選還原階段失敗保留舊 day，重試後只還原一次', async () => {
    const tripId = 'replace-restore-outage';
    await seed(tripId);
    expect((await put(tripId, replacement('備選'))).status).toBe(200);
    const before = await read(tripId);
    const body = { date: '2026-09-23', dayOfWeek: '三', label: '保留備選', timeline: [{ name: '備選景點0' }, { name: '備選景點1' }] };
    expect((await put(tripId, body, failingApi(/INSERT.*INTO trip_entry_pois/, 2))).status).toBe(500);
    expect(await read(tripId)).toEqual(before);
    expect((await put(tripId, body)).status).toBe(200);
    expect(await read(tripId)).toMatchObject({ version: 2, timeline: [
      { entryPoisVersion: '2', alternates: [{ name: '備選備選0', note: '備選備註', reservation: '待確認' }] },
      { entryPoisVersion: '2', alternates: [{ name: '備選備選1', note: '備選備註', reservation: '待確認' }] },
    ] });
  });

  it.each([
    { timeline: {} },
    { timeline: [null] },
    { timeline: [{ description: { invalid: true } }] },
    { timeline: [{ stopPois: [{ poiId: -1 }] }] },
    { timeline: [{ stopPois: [{ poiId: 99999999 }] }] },
    { timeline: [{ stopPois: [{ name: '無效類型', type: 'spaceship' }] }] },
    { hotel: { name: { invalid: true } } },
    { hotel: { name: '有問題的飯店', parking: [null] } },
  ])('無效輸入 %j 回 400，保留完整舊內容', async (invalid) => {
    const tripId = `replace-invalid-${crypto.randomUUID()}`;
    await seed(tripId);
    expect((await put(tripId, replacement('合法'))).status).toBe(200);
    const before = await read(tripId);
    const response = await put(tripId, { ...replacement('無效'), ...invalid });
    expect(response.status).toBe(400);
    expect(await read(tripId)).toEqual(before);
  });

  it('名稱重寫依順序保留各 entry 備選的備註與預訂，不混用相同正選', async () => {
    const tripId = 'replace-restored-metadata';
    await seed(tripId);
    const original = replacement('還原');
    original.timeline.forEach((e, i) => { e.stopPois[0]!.name = '共用正選'; e.stopPois[1]!.note = `各自備註${i}`; });
    expect((await put(tripId, original)).status).toBe(200);
    const response = await put(tripId, { date: '2026-09-23', dayOfWeek: '三', label: '改名',
      timeline: [{ name: '共用正選', note: '新正選備註' }, { name: '共用正選' }],
    });
    expect(response.status).toBe(200);
    expect(await read(tripId)).toMatchObject({ version: 2, timeline: [
      { entryPoisVersion: '2', master: { note: '新正選備註' }, alternates: [{ name: '還原備選0', note: '各自備註0', reservation: '待確認', reservationUrl: 'https://example.com/alt' }] },
      { entryPoisVersion: '2', alternates: [{ name: '還原備選1', note: '各自備註1', reservation: '待確認', reservationUrl: 'https://example.com/alt' }] },
    ] });
  });

  it('正選寫入故障後保留完整舊 day，解除故障後可重試', async () => {
    const tripId = 'replace-junction-outage';
    await seed(tripId);
    expect((await put(tripId, replacement('舊'))).status).toBe(200);
    const before = await read(tripId);
    const failed = await put(tripId, replacement('新'), failingApi(/INSERT.*INTO trip_entry_pois/));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await read(tripId)).toEqual(before);
    expect((await put(tripId, replacement('新'))).status).toBe(200);
    expect(await read(tripId)).toMatchObject({ label: '新', timeline: [
      { master: { name: '新景點0', note: '正選備註', reservation: '已預訂' }, alternates: [{ name: '新備選0', note: '備選備註', reservation: '待確認' }] },
      { master: { name: '新景點1' }, alternates: [{ name: '新備選1' }] },
    ], hotel: { name: '新飯店', parking: [{ name: '新停車場' }] } });
  });
});
