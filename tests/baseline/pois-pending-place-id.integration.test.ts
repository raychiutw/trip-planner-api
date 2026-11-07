/**
 * GET /api/admin/pois-pending-place-id — 回填工具用清單（#1608）：帶 lat／lng、after_id 游標、僅 place_id IS NULL。
 * 兩個入口（trip-planner 舊入口、trip-planner-api）共用同一組案例。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';

type Row = { id: number; name: string; address: string | null; lat: number | null; lng: number | null; place_id: null };
let db: D1Database;
let api: Api;
let token: string;
let startId: number;
const tag = 'q1608-';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  token = await serviceToken(db, ['ops:poi']);
  startId = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM pois').first<{ m: number }>())!.m;
  await db.prepare("INSERT INTO pois (type, name, lat, lng) VALUES ('restaurant', ?, 26.2124, 127.6809)").bind(`${tag}with-coord`).run();
  await db.prepare("INSERT INTO pois (type, name) VALUES ('restaurant', ?)").bind(`${tag}no-coord`).run();
  await db.prepare("INSERT INTO pois (type, name, place_id) VALUES ('restaurant', ?, 'ChIJ-has')").bind(`${tag}has-place`).run();
  await db.prepare("INSERT INTO pois (type, name, lat, lng) VALUES ('restaurant', ?, 26.3, 127.7)").bind(`${tag}third`).run();
});

afterAll(async () => {
  await db.prepare('DELETE FROM pois WHERE id > ?').bind(startId).run();
  await disposeMiniflare();
});

const list = async (qs: string): Promise<Row[]> => {
  const res = await api.get(`/api/admin/pois-pending-place-id?${qs}`, { bearer: token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { rows: Row[] }).rows;
};

describe('pois-pending-place-id（#1608）', () => {
  it('每筆帶 lat／lng，無座標為 null；不回已有 place_id 的列', async () => {
    const rows = await list(`after_id=${startId}`);
    expect(rows.map((r) => r.name)).toEqual([`${tag}with-coord`, `${tag}no-coord`, `${tag}third`]);
    expect(rows[0]).toMatchObject({ lat: 26.2124, lng: 127.6809, place_id: null });
    expect(rows[1]).toMatchObject({ lat: null, lng: null });
  });

  it('after_id 游標：id 升冪、嚴格大於、可走完整份清單', async () => {
    const seen: number[] = [];
    let cursor = startId;
    for (let i = 0; i < 5; i++) {
      const rows = await list(`after_id=${cursor}&limit=2`);
      if (rows.length === 0) break;
      expect(rows.length).toBeLessThanOrEqual(2);
      seen.push(...rows.map((r) => r.id));
      cursor = rows[rows.length - 1].id;
    }
    expect(seen.length).toBe(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(3);
  });

  it('after_id 邊界：最後一筆之後為空；省略時等同從頭', async () => {
    const all = await list(`after_id=${startId}`);
    expect(await list(`after_id=${all[all.length - 1].id}`)).toEqual([]);
    expect((await list('limit=500')).length).toBeGreaterThanOrEqual(3);
  });

  it('limit 上限維持 500', async () => {
    await db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 510)
       INSERT INTO pois (type, name) SELECT 'restaurant', 'q1608-bulk-' || i FROM n`,
    ).run();
    expect((await list(`after_id=${startId}&limit=100000`)).length).toBe(500);
  });

  it('無 ops:poi scope → 403', async () => {
    const other = await serviceToken(db, ['ops:cache'], 'q1608-other');
    expect((await api.get('/api/admin/pois-pending-place-id', { bearer: other })).status).toBe(403);
  });
});
