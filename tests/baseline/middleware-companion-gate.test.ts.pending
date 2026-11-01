/**
 * Middleware companion gate (poi-favorites-rename §5.1)
 *
 * 端對端驗證：V2 Bearer token → middleware attaches auth.scopes / auth.clientId
 * → poi-favorites 的 companion 三 gate（X-Request-Scope header + scopes 含
 * 'companion' + clientId === env.TP_REQUEST_CLIENT_ID）。
 *
 *   case (a) 三條件全符合 → companion mapping 啟用（以 request 提交者的身分建立收藏）
 *   case (b) 缺 scope（OAuth scopes 不含 companion）→ 401 + audit self_reported_scope
 *   case (c) 缺 clientId（mismatch）→ 401 + audit client_unauthorized
 *   case (d) 缺 header（X-Request-Scope）→ V2 user 路徑（無 user → 401，不寫 audit）
 *
 * 走 HTTP 邊界：真實 AccessToken row + 真實路由派送（middleware → handler → _companion），
 * 不再手寫 context 呼叫 onRequest / resolveCompanionUserId；結果改驗回應與真實 D1 的資料變化。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser, seedTrip, seedPoi } from './helpers';
import { createApi, type Api } from './http';
import { serviceTokenFor } from './service-token';
import { cleanupTrips } from './cleanup-trips';

let db: D1Database;
let api: Api;
let submitterId: string;
let poiId: number;
const requestIds: number[] = [];

const TP_REQUEST_CLIENT_ID = 'tripline-internal-cli';
const SUBMITTER_EMAIL = 'companion-gate-submitter@test.com';
const TRIP_ID = 'companion-gate-trip-1';

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { TP_REQUEST_CLIENT_ID, ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' }) });
  submitterId = await seedUser(db, SUBMITTER_EMAIL);
  await seedTrip(db, { id: TRIP_ID, owner: SUBMITTER_EMAIL });
  poiId = await seedPoi(db, { name: 'companion-gate-poi' });
});

beforeEach(async () => {
  await db.prepare('DELETE FROM poi_favorites WHERE user_id = ?').bind(submitterId).run();
});

afterAll(async () => {
  for (const id of requestIds) {
    await db.prepare('DELETE FROM companion_request_actions WHERE request_id = ?').bind(id).run();
    await db.prepare('DELETE FROM audit_log WHERE request_id = ?').bind(id).run();
    await db.prepare('DELETE FROM trip_requests WHERE id = ?').bind(id).run();
  }
  await db.prepare('DELETE FROM poi_favorites WHERE user_id = ?').bind(submitterId).run();
  await cleanupTrips(db, [TRIP_ID], ['companion-gate-poi']);
  await db.prepare('DELETE FROM users WHERE id = ?').bind(submitterId).run();
  await disposeMiniflare();
});

async function seedRequest(): Promise<number> {
  const row = await db
    .prepare(
      'INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id',
    )
    .bind(TRIP_ID, 'gate test', SUBMITTER_EMAIL, 'processing')
    .first<{ id: number }>();
  requestIds.push(row!.id);
  return row!.id;
}

function postFavorite(token: string, requestId: number, withScopeHeader = true): Promise<Response> {
  return api.request('POST', 'https://test.com/api/poi-favorites', {
    bearer: token,
    headers: {
      ...(withScopeHeader ? { 'X-Request-Scope': 'companion' } : {}),
      Origin: 'https://trip-planner-dby.pages.dev',
    },
    json: { poiId, companionRequestId: requestId },
  });
}

async function failureReason(requestId: number): Promise<string | undefined> {
  const audit = await db
    .prepare(
      `SELECT companion_failure_reason FROM audit_log
       WHERE trip_id = 'system:companion' AND request_id = ? AND companion_failure_reason IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(requestId)
    .first<{ companion_failure_reason: string }>();
  return audit?.companion_failure_reason;
}

async function favoritesOf(userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM poi_favorites WHERE user_id = ? AND poi_id = ? AND deleted_at IS NULL')
    .bind(userId, poiId)
    .first<{ n: number }>();
  return row!.n;
}

describe('middleware companion gate (§5.1)', () => {
  it('case (a) Bearer companion scope + 對的 clientId + 對的 header → 三 gate 全過 / 以 request 提交者身分建立收藏', async () => {
    const token = await serviceTokenFor(db, { clientId: TP_REQUEST_CLIENT_ID, scopes: ['companion'] });
    const requestId = await seedRequest();

    const res = await postFavorite(token, requestId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { userId: string; poiId: number };
    // middleware 把 scopes / clientId 帶進去，三 gate 才會過；收藏歸屬是 request 提交者，不是 service token
    expect(body.userId).toBe(submitterId);
    expect(body.poiId).toBe(poiId);
    expect(await favoritesOf(submitterId)).toBe(1);

    // companion 寫入留下以 request 為單位的稽核
    const audit = await db
      .prepare(`SELECT changed_by FROM audit_log WHERE trip_id = 'system:companion' AND request_id = ? AND table_name = 'poi_favorites'`)
      .bind(requestId)
      .first<{ changed_by: string }>();
    expect(audit?.changed_by).toBe(`companion:${requestId}`);
    expect(await failureReason(requestId)).toBeUndefined();
  });

  it('case (b) Bearer 不含 companion scope → 401 + audit self_reported_scope', async () => {
    const token = await serviceTokenFor(db, { clientId: TP_REQUEST_CLIENT_ID, scopes: ['admin'] }); // 缺 companion
    const requestId = await seedRequest();

    const res = await postFavorite(token, requestId);
    expect(res.status).toBe(401);
    expect(await failureReason(requestId)).toBe('self_reported_scope');
    expect(await favoritesOf(submitterId)).toBe(0);
  });

  it('case (c) Bearer 含 companion scope 但 clientId 不對 → 401 + audit client_unauthorized', async () => {
    const token = await serviceTokenFor(db, { clientId: 'rogue-cli', scopes: ['companion'] });
    const requestId = await seedRequest();

    const res = await postFavorite(token, requestId);
    expect(res.status).toBe(401);
    expect(await failureReason(requestId)).toBe('client_unauthorized');
    expect(await favoritesOf(submitterId)).toBe(0);
  });

  it('case (d) 缺 X-Request-Scope header → 走 V2 user 路徑（服務 token 無 user → 401，不寫 audit）', async () => {
    const token = await serviceTokenFor(db, { clientId: TP_REQUEST_CLIENT_ID, scopes: ['companion'] });
    const requestId = await seedRequest();

    const res = await postFavorite(token, requestId, false);
    expect(res.status).toBe(401);

    const audit = await db
      .prepare(`SELECT id FROM audit_log WHERE trip_id = 'system:companion' AND request_id = ?`)
      .bind(requestId)
      .first();
    expect(audit).toBeNull();
    expect(await favoritesOf(submitterId)).toBe(0);
  });
});
