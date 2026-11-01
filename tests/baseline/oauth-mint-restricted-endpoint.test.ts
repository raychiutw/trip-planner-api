/**
 * POST /api/oauth/mint-restricted — Option E：由 request_id 直接簽發 owner 身份的
 * 「只能寫單一 trip」access token，供 tp-request api-server 注入 contained session。
 * 走 HTTP 邊界（tests/api/http.ts），trip_requests／trips／Consent／AccessToken 都是真實 D1 資料列。
 *
 * 與 downscope 不同：caller 不帶 owner Bearer，而是可信 api-server 帶 API_SECRET；
 * server 端由 request_id 推 trip/owner、查既有 Consent，再簽發。鎖住不變式：
 *   - API_SECRET 正確 + request open/processing + owner 有 Consent → 發 restrict_trip token
 *   - API_SECRET 錯 / 缺 → AUTH_REQUIRED（不發 token）
 *   - request 不存在 / 非 open|processing → 不發 token（防對已結案請求 mint）
 *   - owner 無 Consent（未授權 AI）→ PERM_DENIED（不發 token）
 *   - 簽發 token：user_id=owner（非 caller）、client_id=tripline-tp-request、restrict_trip=trip
 *
 * 形式改變的斷言（原本斷言 mock 的呼叫參數）：
 *   - 「D1Adapter('AccessToken').upsert 的 token／payload／ttl」→ 讀 oauth_models 真實資料列（token 為隨機值，不比對字面）
 *   - 「查了 owner 對 tp-request 的 consent（mockConsentFind 的參數）」→ Consent 只種在正確 key：有就 mint、沒有就 PERM_DENIED
 *   - 「API_SECRET 錯 → 不碰 DB」→ 無法從 HTTP 觀察 DB 呼叫；改驗 request 狀態不變、沒有任何 token 被簽發
 *   - 「成功 mint 寫 auth_audit」原本只驗 upsert 一次；改為讀 auth_audit_log 真實資料列（比原本更強）
 *   - 「request 不存在／非 open／owner 查不到」原本接受 code 的 regex（NOT_FOUND|DATA_VALIDATION…）；改為精確的 status + code
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const TTL_SEC = 2 * 60 * 60;
const SECRET = 'mrs-test-api-secret';
const CLIENT = 'tripline-tp-request';
// 共用 D1：本檔專用 email／trip id
const OWNER_EMAIL = 'mrs-owner@test.com';
const TRIP = 'mrs-trip-x';
const GHOST_TRIP = 'mrs-trip-without-row';

let db: D1Database;
let api: Api;
let ownerUserId: string;
const requestIds: number[] = [];

async function seedRequest(tripId: string, status: 'open' | 'processing' | 'completed' | 'failed'): Promise<number> {
  const row = await db
    .prepare('INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(tripId, 'mrs 測試請求', OWNER_EMAIL, status)
    .first<{ id: number }>();
  requestIds.push(row!.id);
  return row!.id;
}

const seedConsent = () =>
  new D1Adapter(db, 'Consent').upsert(
    `${ownerUserId}:${CLIENT}`,
    { user_id: ownerUserId, client_id: CLIENT, scopes: ['openid', 'profile'], grantedAt: 1 },
    300,
  );

async function mintedTokens() {
  const { results } = await db
    .prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'AccessToken' AND json_extract(payload, '$.user_id') = ?")
    .bind(ownerUserId)
    .all<{ id: string; payload: string; expires_at: number }>();
  return results;
}

async function auditRows() {
  const { results } = await db
    .prepare("SELECT event_type, outcome, user_id, client_id, failure_reason, metadata FROM auth_audit_log WHERE user_id = ? ORDER BY id")
    .bind(ownerUserId)
    .all<{ event_type: string; outcome: string; user_id: string; client_id: string; failure_reason: string | null; metadata: string }>();
  return results;
}

const requestStatus = (id: number) =>
  db.prepare('SELECT status, terminal_reason, reply FROM trip_requests WHERE id = ?').bind(id).first<{ status: string; terminal_reason: string | null; reply: string | null }>();

const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

async function cleanState() {
  await db.prepare("DELETE FROM oauth_models WHERE name IN ('Consent', 'AccessToken') AND json_extract(payload, '$.user_id') = ?").bind(ownerUserId).run();
  await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(ownerUserId).run();
}

const mint = (body: unknown, authHeader: string | null = `Bearer ${SECRET}`, client: Api = api) =>
  client.request('POST', '/api/oauth/mint-restricted', {
    json: body,
    ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
  });

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { TRIPLINE_API_SECRET: SECRET }) });
  ownerUserId = (await seedTrip(db, { id: TRIP, owner: OWNER_EMAIL })).ownerUserId;
}, 30000);

beforeEach(async () => {
  await cleanState();
  await seedConsent(); // 預設 owner 已授權 AI
});

afterAll(async () => {
  await cleanState();
  for (const id of requestIds) await db.prepare('DELETE FROM trip_requests WHERE id = ?').bind(id).run();
  await db.prepare('DELETE FROM trip_permissions WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_days WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trips WHERE id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(ownerUserId).run();
  await disposeMiniflare();
});

describe('POST /api/oauth/mint-restricted', () => {
  it('API_SECRET + open request + consent → 發 owner restrict_trip token', async () => {
    const id = await seedRequest(TRIP, 'processing');
    const before = Date.now();
    const res = await mint({ request_id: id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: TTL_SEC, restrict_trip: TRIP });
    expect(typeof body.access_token).toBe('string');
    expect((body.access_token as string).length).toBeGreaterThan(20);
    expect(res.headers.get('cache-control')).toBe('no-store');

    // 簽發 token：user_id=owner（非 caller）、client_id=tp-request、restrict_trip=trip、scopes 空
    const tokens = await mintedTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).toBe(body.access_token);
    const payload = JSON.parse(tokens[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ user_id: ownerUserId, client_id: CLIENT, restrict_trip: TRIP, scopes: [] });
    expect(payload.grantId).toBeTruthy();
    expect(tokens[0]!.expires_at - before).toBeGreaterThan(TTL_SEC * 1000 - 60_000);
    expect(tokens[0]!.expires_at - before).toBeLessThan(TTL_SEC * 1000 + 60_000);
  });

  it('open 狀態的 request 同樣可 mint；consent 只認 owner 對 tp-request 的 key（形式改變：原為 mockConsentFind 參數）', async () => {
    // Consent 種錯 key（別的 client）→ 不算授權
    await cleanState();
    await new D1Adapter(db, 'Consent').upsert(
      `${ownerUserId}:mrs-other-client`,
      { user_id: ownerUserId, client_id: 'mrs-other-client', scopes: [], grantedAt: 1 },
      300,
    );
    const id = await seedRequest(TRIP, 'open');
    const denied = await mint({ request_id: id });
    expect(denied.status).toBe(403);
    expect(await mintedTokens()).toHaveLength(0);
    // 種對 key → 同一個 request 之後可以 mint（open 在白名單內）
    await seedConsent();
    await db.prepare("UPDATE trip_requests SET status = 'open', terminal_reason = NULL WHERE id = ?").bind(id).run();
    const ok = await mint({ request_id: id });
    expect(ok.status).toBe(200);
  });

  it('request_id 帶前後空白（string）→ trim 後照 mint（覆蓋 rawId.trim() 分支）', async () => {
    const id = await seedRequest(TRIP, 'processing');
    const res = await mint({ request_id: `  ${id}  ` });
    expect(res.status).toBe(200);
    const tokens = await mintedTokens();
    expect(tokens).toHaveLength(1);
    expect(JSON.parse(tokens[0]!.payload)).toMatchObject({ user_id: ownerUserId, restrict_trip: TRIP });
  });

  it('request_id 只有空白 → DATA_VALIDATION（trim 後為空，不當成查不到的 request）', async () => {
    const res = await mint({ request_id: '   ' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('成功 mint → 寫 auth_audit（token_issue/success，owner 身份）', async () => {
    const id = await seedRequest(TRIP, 'processing');
    expect((await mint({ request_id: id })).status).toBe(200);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'token_issue', outcome: 'success', user_id: ownerUserId, client_id: CLIENT });
    expect(JSON.parse(rows[0]!.metadata)).toMatchObject({ grant_type: 'mint-restricted', request_id: String(id), restrict_trip: TRIP });
  });

  it('API_SECRET 錯 → AUTH_REQUIRED，不發 token', async () => {
    const id = await seedRequest(TRIP, 'processing');
    const res = await mint({ request_id: id }, 'Bearer wrong');
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('AUTH_REQUIRED');
    expect(await mintedTokens()).toHaveLength(0);
    expect((await requestStatus(id))!.status).toBe('processing');
    expect(await auditRows()).toHaveLength(0);
  });

  it('API_SECRET 長度相同但內容不同 → AUTH_REQUIRED（常數時間比對仍逐字比）', async () => {
    const id = await seedRequest(TRIP, 'processing');
    const sameLength = `${SECRET.slice(0, -1)}X`;
    expect(sameLength).toHaveLength(SECRET.length);
    const res = await mint({ request_id: id }, `Bearer ${sameLength}`);
    expect(res.status).toBe(401);
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('缺 Authorization → AUTH_REQUIRED', async () => {
    const id = await seedRequest(TRIP, 'processing');
    const res = await mint({ request_id: id }, null);
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('AUTH_REQUIRED');
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('env 無 API_SECRET → AUTH_REQUIRED（fail-closed，不因未設定就放行）', async () => {
    const id = await seedRequest(TRIP, 'processing');
    const noSecret = createApi({ env: mockEnv(db, { TRIPLINE_API_SECRET: '' }) });
    const res = await mint({ request_id: id }, 'Bearer ', noSecret);
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('AUTH_REQUIRED');
    // 連 env 完全沒設也一樣
    const unset = createApi({ env: mockEnv(db) });
    const res2 = await mint({ request_id: id }, 'Bearer undefined', unset);
    expect(res2.status).toBe(401);
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('缺 request_id → DATA_VALIDATION', async () => {
    const res = await mint({});
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('DATA_VALIDATION');
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('request 不存在 → 不發 token', async () => {
    const res = await mint({ request_id: 999999999 });
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('DATA_NOT_FOUND');
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('request 非 open|processing（completed）→ 不發 token（防對已結案 mint）', async () => {
    const id = await seedRequest(TRIP, 'completed');
    const res = await mint({ request_id: id });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('PERM_DENIED');
    expect(await mintedTokens()).toHaveLength(0);
    expect((await requestStatus(id))!.status).toBe('completed');
  });

  it('request 為 failed 同樣不發 token', async () => {
    const id = await seedRequest(TRIP, 'failed');
    const res = await mint({ request_id: id });
    expect(res.status).toBe(403);
    expect(await mintedTokens()).toHaveLength(0);
  });

  it('owner 無 Consent（未授權 AI）→ PERM_DENIED，不發 token', async () => {
    await cleanState(); // 移除 beforeEach 種的 Consent
    const id = await seedRequest(TRIP, 'processing');
    const res = await mint({ request_id: id });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('PERM_DENIED');
    expect(await mintedTokens()).toHaveLength(0);
    // 留 forensic trail：token_issue/failure/no_consent
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'token_issue', outcome: 'failure', failure_reason: 'no_consent', client_id: CLIENT });
    // queue-jam 防禦：request 被 park 成 failed / needs_consent，不卡佇列
    expect(await requestStatus(id)).toMatchObject({ status: 'failed', terminal_reason: 'needs_consent' });
  });

  // Queue release、linked cleanup、storage faults 與 terminal races 改由
  // tests/api/request-automatic-termination.integration.test.ts 透過真實 D1 驗證。

  it('trip owner 查不到 → 不發 token', async () => {
    // trip_requests.trip_id 沒有 FK：request 指向不存在的 trip
    const id = await seedRequest(GHOST_TRIP, 'processing');
    const res = await mint({ request_id: id });
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('DATA_NOT_FOUND');
    expect(await mintedTokens()).toHaveLength(0);
  });
});
