/**
 * 已發布行程的匿名讀取可快取（#1669）
 *
 * PWA service worker 的 cacheWillUpdate 會拒絕 no-store／private，所以「已發布＋匿名」的成功讀取要回
 * `public, max-age=0, must-revalidate`（離線可用快取、上線每次重新驗證）。其餘一律維持不可快取：
 * 登入身分（middleware 覆寫成 private, no-store）、未發布、權限不足、404／4xx。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

let db: D1Database;
let api: Api;
const PUB = 'pubcache-pub-trip';
const PRIV = 'pubcache-priv-trip';
const OWNER = 'pubcache-owner@test.com';
const STRANGER = 'pubcache-stranger@test.com';
let pubEntry: number;
let privEntry: number;

const PUBLIC_CC = 'public, max-age=0, must-revalidate';
const cc = (r: Response) => r.headers.get('cache-control');
const paths = (id: string, eid: number) => [
  `/api/trips/${id}`,
  `/api/trips/${id}/days`,
  `/api/trips/${id}/days?all=1`,
  `/api/trips/${id}/days/1`,
  `/api/trips/${id}/entries/${eid}`,
  `/api/trips/${id}/segments`,
];

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedTrip(db, { id: PUB, owner: OWNER, published: 1 });
  await seedTrip(db, { id: PRIV, owner: OWNER, published: 0 });
  pubEntry = await seedEntry(db, await getDayId(db, PUB, 1));
  privEntry = await seedEntry(db, await getDayId(db, PRIV, 1));
});

afterAll(async () => {
  await cleanupTrips(db, [PUB, PRIV]);
  await disposeMiniflare();
});

describe('匿名讀已發布行程 → public, max-age=0, must-revalidate', () => {
  it.each(paths(PUB, 0))('%s', async (p) => {
    const path = p.replace('/entries/0', `/entries/${pubEntry}`);
    const res = await api.get(path);
    expect(res.status).toBe(200);
    expect(cc(res)).toBe(PUBLIC_CC);
  });
});

describe('有登入身分讀同一份已發布行程 → private, no-store', () => {
  it.each(paths(PUB, 0))('%s', async (p) => {
    const path = p.replace('/entries/0', `/entries/${pubEntry}`);
    for (const as of [OWNER, STRANGER]) {
      const res = await api.get(path, { as });
      expect(res.status).toBe(200);
      expect(cc(res)).toBe('private, no-store');
    }
  });
});

describe('不可快取的情形', () => {
  it.each(paths(PRIV, 0))('匿名讀未發布 %s → 403 且 no-store', async (p) => {
    const res = await api.get(p.replace('/entries/0', `/entries/${privEntry}`));
    expect(res.status).toBe(403);
    expect(cc(res)).toBe('no-store');
  });

  it('登入但非成員讀未發布 → 403 且不是 public', async () => {
    const res = await api.get(`/api/trips/${PRIV}`, { as: STRANGER });
    expect(res.status).toBe(403);
    expect(cc(res)).toBe('private, no-store');
  });

  it.each([
    ['行程不存在', '/api/trips/pubcache-nope'],
    ['已發布行程的 day 不存在', `/api/trips/${PUB}/days/99`],
    ['已發布行程的 entry 不存在', `/api/trips/${PUB}/entries/999999999`],
    ['entry 不屬於該行程', `/api/trips/${PUB}/entries/__PRIV__`],
    ['entry id 格式錯誤', `/api/trips/${PUB}/entries/abc`],
  ])('匿名 %s → 4xx 且 no-store', async (_n, p) => {
    const res = await api.get(p.replace('__PRIV__', String(privEntry)));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(cc(res)).toBe('no-store');
  });

  it('已發布行程的非公開端點（notes）不受影響', async () => {
    const res = await api.get(`/api/trips/${PUB}/notes`);
    expect(cc(res)).not.toBe(PUBLIC_CC);
    expect(cc(res)).toMatch(/no-store/);
  });
});
