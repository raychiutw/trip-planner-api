/**
 * POST /api/oauth/downscope — trip-scoped token exchange (v2.55.56)
 * 走 HTTP 邊界（tests/api/http.ts）：呼叫端是真實的 AccessToken 資料列，寫權來自真實的 trip_permissions。
 *
 * 換發「只能寫單一 trip」的 access token，供 tp-request api-server 注入 ephemeral
 * session（confused-deputy 緩解）。鎖住授權不變式：
 *   - user 有寫權 → 發 restrict_trip payload token + 2h TTL
 *   - 無寫權 / service token / 已受限 token → 拒（不發 token）
 *   - 缺 trip_id → 400
 *
 * 與 oauth-downscope.integration.test.ts 互補、不重複：那份驗 middleware 把 Bearer 解析到 handler、
 * 以及 restrict_trip 的跨 trip 強制；這份逐項驗 handler 的 payload／TTL／audit／不發 token 的細節。
 * （本檔用 dse- 前綴，與 integration 檔的 ds- 前綴不互相污染。）
 *
 * 形式改變的斷言（原本斷言 mock 的呼叫參數）：
 *   - 「upsert 的 token／payload／ttl」→ 讀 oauth_models 真實資料列（token 為隨機值，不比對字面）
 *   - 「recordAuthEvent 被呼叫」→ 讀 auth_audit_log 真實資料列
 *   - 「service／已受限 token 不查寫權」→ 無法觀察呼叫；改驗沒有 no_write_permission 的 audit failure 列
 *     （寫權檢查失敗才會寫那一列，沒有那列即表示在寫權檢查之前就被擋）
 *   - 「hasWritePermission」mock → 以真實 trip_permissions（owner 有、局外人沒有）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const DOWNSCOPE_TTL_SEC = 2 * 60 * 60;
// 共用 D1：本檔專用 email／trip／client／token 前綴
const OWNER_EMAIL = 'dse-owner@test.com';
const OUTSIDER_ID = 'dse-outsider';
const TRIP = 'dse-trip-x';
// 第一方 AI client：hasTripScope 對它豁免 scopes（授權來自 Consent + restrict_trip），真實 pipeline 就是用它呼叫 downscope
const CLIENT = 'tripline-tp-request';
const SERVICE_CLIENT = 'dse-service-client';

let db: D1Database;
let api: Api;
let ownerUserId: string;

async function seedToken(token: string, opts: { userId: string | null; restrictTrip?: string; clientId?: string; scopes?: string[] }) {
  await new D1Adapter(db, 'AccessToken').upsert(
    token,
    {
      jti: token,
      client_id: opts.clientId ?? CLIENT,
      user_id: opts.userId,
      scopes: opts.scopes ?? ['openid', 'profile'],
      grantId: `grant-${token}`,
      ...(opts.restrictTrip ? { restrict_trip: opts.restrictTrip } : {}),
    },
    300,
  );
}

const downscope = (body: unknown, bearer: string) =>
  api.request('POST', '/api/oauth/downscope', { json: body, bearer });

/** 被換發出來的 token：同 user／client、id 不是呼叫端自己種的 dse- 開頭（換發的 id 是隨機 opaque）。 */
async function mintedBesides(callerToken: string) {
  const { results } = await db
    .prepare("SELECT id FROM oauth_models WHERE name = 'AccessToken' AND id != ? AND id NOT LIKE 'dse-%' AND (json_extract(payload, '$.user_id') IN (?, ?) OR json_extract(payload, '$.client_id') = ?)")
    .bind(callerToken, ownerUserId, OUTSIDER_ID, SERVICE_CLIENT)
    .all<{ id: string }>();
  return results;
}

type Audit = { event_type: string; outcome: string; user_id: string | null; client_id: string; failure_reason: string | null; metadata: string };
const auditRows = (who: { userId: string } | { clientId: string }) =>
  ('userId' in who
    ? db.prepare('SELECT event_type, outcome, user_id, client_id, failure_reason, metadata FROM auth_audit_log WHERE user_id = ? ORDER BY id').bind(who.userId)
    : db.prepare('SELECT event_type, outcome, user_id, client_id, failure_reason, metadata FROM auth_audit_log WHERE client_id = ? ORDER BY id').bind(who.clientId)
  ).all<Audit>().then(r => r.results);

async function cleanState() {
  await db.prepare("DELETE FROM oauth_models WHERE name = 'AccessToken' AND (id LIKE 'dse-%' OR json_extract(payload, '$.user_id') IN (?, ?) OR json_extract(payload, '$.client_id') = ?)").bind(ownerUserId, OUTSIDER_ID, SERVICE_CLIENT).run();
  await db.prepare('DELETE FROM auth_audit_log WHERE user_id IN (?, ?) OR client_id = ?').bind(ownerUserId, OUTSIDER_ID, SERVICE_CLIENT).run();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  ownerUserId = (await seedTrip(db, { id: TRIP, owner: OWNER_EMAIL })).ownerUserId;
  expect(ownerUserId).toBe(userIdFor(OWNER_EMAIL));
}, 30000);

beforeEach(cleanState);

afterAll(async () => {
  await cleanState();
  await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_days WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trips WHERE id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(ownerUserId).run();
  await disposeMiniflare();
});

describe('POST /api/oauth/downscope', () => {
  it('user 有寫權 → 發 restrict_trip token（2h TTL）', async () => {
    const caller = 'dse-caller-ok';
    await seedToken(caller, { userId: ownerUserId });
    const before = Date.now();
    const res = await downscope({ trip_id: TRIP }, caller);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: DOWNSCOPE_TTL_SEC, restrict_trip: TRIP });
    expect(typeof body.access_token).toBe('string');
    expect(body.access_token).not.toBe(caller);
    // token 不得被快取
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');

    // AccessToken row：帶 restrict_trip payload + 2h TTL，user／client／scopes 沿用 caller
    const row = await db
      .prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'AccessToken' AND id = ?")
      .bind(body.access_token as string)
      .first<{ payload: string; expires_at: number }>();
    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      user_id: ownerUserId,
      client_id: CLIENT,
      scopes: ['openid', 'profile'],
      restrict_trip: TRIP,
    });
    expect(payload.grantId).toBeTruthy();
    expect(payload.grantId).not.toBe(`grant-${caller}`);
    expect(row!.expires_at - before).toBeGreaterThan(DOWNSCOPE_TTL_SEC * 1000 - 60_000);
    expect(row!.expires_at - before).toBeLessThan(DOWNSCOPE_TTL_SEC * 1000 + 60_000);

    // audit success
    const audit = await auditRows({ userId: ownerUserId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event_type: 'token_issue', outcome: 'success', user_id: ownerUserId });
    expect(JSON.parse(audit[0]!.metadata)).toMatchObject({ grant_type: 'downscope', restrict_trip: TRIP });
  });

  it('無寫權 → PERM_DENIED，不發 token，記 failure', async () => {
    const caller = 'dse-caller-outsider';
    // 新 api 的 bearer 驗證在使用者不存在時 fail-closed（401），所以 outsider 要有真實使用者資料列
    await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(OUTSIDER_ID, 'dse-outsider@test.com', 'outsider').run();
    await seedToken(caller, { userId: OUTSIDER_ID });
    const res = await downscope({ trip_id: TRIP }, caller);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERM_DENIED');
    expect(await mintedBesides(caller)).toHaveLength(0);
    const audit = await auditRows({ userId: OUTSIDER_ID });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event_type: 'token_issue', outcome: 'failure', failure_reason: 'no_write_permission', user_id: OUTSIDER_ID });
  });

  it('service token（user_id=null）→ PERM_DENIED，不查寫權也不發 token', async () => {
    const caller = 'dse-caller-service';
    await seedToken(caller, { userId: null, clientId: SERVICE_CLIENT, scopes: ['ops:trips:read'] });
    const res = await downscope({ trip_id: TRIP }, caller);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERM_DENIED');
    expect(await mintedBesides(caller)).toHaveLength(0);
    // 寫權檢查失敗才會留 no_write_permission 紀錄；沒有表示在檢查之前就被擋
    expect(await auditRows({ clientId: SERVICE_CLIENT })).toHaveLength(0);
  });

  it('已受限 token → PERM_DENIED（防外洩受限 token 再提權）', async () => {
    const caller = 'dse-caller-restricted';
    await seedToken(caller, { userId: ownerUserId, restrictTrip: 'dse-trip-y' });
    const res = await downscope({ trip_id: TRIP }, caller);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERM_DENIED');
    expect(await mintedBesides(caller)).toHaveLength(0);
    expect(await auditRows({ userId: ownerUserId })).toHaveLength(0);
  });

  it('缺 trip_id → DATA_VALIDATION', async () => {
    const caller = 'dse-caller-missing';
    await seedToken(caller, { userId: ownerUserId });
    const res = await downscope({}, caller);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DATA_VALIDATION');
    expect(await mintedBesides(caller)).toHaveLength(0);
    // 空白 trip_id 同樣視為缺
    const blank = await downscope({ trip_id: '   ' }, caller);
    expect(blank.status).toBe(400);
  });
});
