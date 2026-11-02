/**
 * poi-favorites 寫入端點的 actor 閘門（requireFavoriteActor）
 *
 * companion 分支移除後，收藏端點只認有 userId 的 token。帶 service token（user_id 為 null，
 * 即使有 companion scope、也沒帶 X-Request-Scope header）打寫入端點 → 401 AUTH_REQUIRED，且不寫任何資料。
 * （匿名請求在 auth middleware 就 401，到不了 handler；handler 內的這道閘只有 service token 打得到。）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedPoi } from './helpers';
import { createApi, type Api } from './http';
import { companionToken, TP_REQUEST_CLIENT_ID } from './favorites-http';

const TEST_IP = '198.51.100.77';

let db: D1Database;
let api: Api;
let bearer: string;
let poiId: number;

beforeAll(async () => {
  db = await createTestDb();
  const env = mockEnv(db, { TP_REQUEST_CLIENT_ID, ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' });
  api = createApi({ env });
  bearer = await companionToken(env);
  poiId = await seedPoi(db, { name: 'favactor-POI' });
});

afterAll(async () => {
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${TEST_IP}`).run();
  await disposeMiniflare();
});

const opts = (json?: unknown) => ({ bearer, json, headers: { 'CF-Connecting-IP': TEST_IP, Origin: 'https://trip-planner-dby.pages.dev' } });

describe('收藏寫入端點：service token（無 userId）→ 401 AUTH_REQUIRED', () => {
  it('POST /api/poi-favorites', async () => {
    const res = await api.request('POST', 'https://test.com/api/poi-favorites', opts({ poiId }));
    expect(res.status).toBe(401);
    const row = await db.prepare('SELECT id FROM poi_favorites WHERE poi_id = ?').bind(poiId).first();
    expect(row).toBeNull();
  });

  it('DELETE /api/poi-favorites/:id', async () => {
    const res = await api.request('DELETE', 'https://test.com/api/poi-favorites/999999', opts());
    expect(res.status).toBe(401);
  });

  it('POST /api/poi-favorites/:id/add-to-trip', async () => {
    const res = await api.request('POST', 'https://test.com/api/poi-favorites/999999/add-to-trip', opts({ tripId: 't', dayNum: 1, startTime: '09:00', endTime: '10:00' }));
    expect(res.status).toBe(401);
  });
});
