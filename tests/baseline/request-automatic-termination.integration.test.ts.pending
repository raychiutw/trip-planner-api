/**
 * 自動終結沿用 request 收尾規則（ADR-0007：取消＝停止等待、終結原因獨立成欄、兩層收屍）。
 * 走 HTTP 邊界（tests/api/http.ts）：user 用真實 bearer token，mint-restricted 用 infra secret；
 * 終結結果一律讀真實資料列／回應。
 *
 * 併發與故障注入仍在 DB 這一層：把「會在特定 SQL 上動手腳」的 DB 包進 env 再交給 createApi，
 * 請求本身依舊走 middleware 與路由，與 Pages 一致。
 * 共用 D1：專用 trip id／email（s16-auto-），結束時清掉自己的資料。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { getDayId, mockEnv, seedEntry, seedTrip, seedUser, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { TP_REQUEST_CLIENT_ID } from '../../src/lib/first-party';

const OWNER = 's16-auto-owner@test.com';
const OTHER_OWNER = 's16-auto-other@test.com';
const CONSENTED_OWNER = 's16-auto-consented@test.com';
const TRIP_LIKE = 's16-auto-%';
const SECRET = 'automatic-test-secret';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(async () => {
  const tripIds = (await db.prepare('SELECT id FROM trips WHERE id LIKE ?').bind(TRIP_LIKE).all<{ id: string }>()).results.map((r) => r.id);
  for (const id of tripIds) {
    for (const table of ['trip_health_reports', 'trip_note_ai_jobs', 'trip_requests', 'audit_log']) {
      await db.prepare(`DELETE FROM ${table} WHERE trip_id = ?`).bind(id).run();
    }
  }
  await db.prepare("DELETE FROM oauth_models WHERE name = 'Consent' AND id = ?").bind(`${userIdFor(CONSENTED_OWNER)}:${TP_REQUEST_CLIENT_ID}`).run();
  await db.prepare("DELETE FROM oauth_models WHERE name = 'AccessToken' AND payload LIKE ?").bind('%"restrict_trip":"s16-auto-%').run();
  await cleanupTrips(db, [TRIP_LIKE]);
  await disposeMiniflare();
});

type Json = Record<string, unknown>;

const getRequest = async (id: number | string, as = OWNER, target: Api = api) =>
  (await target.get(`/api/requests/${id}`, { as })).json() as Promise<Json>;
const patchRequest = (id: number | string, body: Json, as = OWNER) =>
  api.request('PATCH', `/api/requests/${id}`, { as, json: body });
const getHealth = async (tripId: string) =>
  (await api.get(`/api/trips/${tripId}/health-check`, { as: OWNER })).json() as Promise<Json>;
const getAiState = async (tripId: string, target: Api = api) =>
  (await target.get(`/api/trips/${tripId}/notes/ai-state`, { as: OWNER })).json() as Promise<Json>;

async function healthRequest(tripId: string) {
  await seedTrip(db, { id: tripId, days: 1, owner: OWNER });
  await seedEntry(db, await getDayId(db, tripId, 1));
  const response = await api.request('POST', `/api/trips/${tripId}/health-check`, { as: OWNER });
  expect(response.status).toBe(202);
  return ((await response.json()) as { report: { requestId: number } }).report.requestId;
}

async function chatRequest(tripId: string) {
  await seedTrip(db, { id: tripId, days: 1, owner: OWNER });
  const response = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId, message: '請幫我安排行程' } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

async function notesRequest(tripId: string) {
  await seedTrip(db, { id: tripId, days: 1, owner: OWNER });
  const response = await api.request('POST', `/api/trips/${tripId}/notes/tips/generate`, { as: OWNER });
  expect(response.status).toBe(202);
  return (await response.json()) as { requestId: number; jobId: number; generation: number };
}

/** infra 呼叫：以 api-server secret 為 request 簽發受限 token（沒有授權時被拒並順手收尾）。 */
function mint(id: number, target: Api = api) {
  return target.request('POST', '/api/oauth/mint-restricted', { bearer: SECRET, json: { request_id: id } });
}
function apiWith(requestDb: D1Database): Api {
  return createApi({ env: mockEnv(requestDb, { TRIPLINE_API_SECRET: SECRET }) });
}
const mintApi = () => apiWith(db);

/** 在第一次執行 `UPDATE trip_requests SET ...` 時，先讓另一個動作（例如 worker 的 PATCH）落地。 */
function beforeRequestUpdate(action: () => Promise<unknown>): D1Database {
  let invoked = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (property === 'first') return async (...args: unknown[]) => {
        if (!invoked) { invoked = true; await action(); }
        return Reflect.apply(member, target, args);
      };
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        return /UPDATE\s+trip_requests\s+SET/.test(sql) ? wrap(statement) : statement;
      };
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** 第一次碰到符合條件的 prepare 就拋錯（模擬收尾寫入故障），之後恢復正常。 */
function failOnce(match: (sql: string) => boolean): D1Database {
  let failed = false;
  return new Proxy(db, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (!failed && property === 'prepare' && match(String(args[0]))) {
          failed = true;
          throw new Error('Injected cleanup outage');
        }
        return Reflect.apply(member, target, args);
      };
    },
  });
}

async function ageRequest(id: number, minutes: number) {
  await db.prepare(`UPDATE trip_requests SET updated_at = datetime('now', ?) WHERE id = ?`).bind(`-${minutes} minutes`, id).run();
}

describe('自動終結沿用 request 收尾規則', () => {
  it('錯誤的跨行程筆記關聯不能終結其他擁有者的 request', async () => {
    const ownTrip = 's16-auto-cross-trip-own';
    const { jobId } = await notesRequest(ownTrip);
    const otherTrip = 's16-auto-cross-trip-other';
    await seedTrip(db, { id: otherTrip, owner: OTHER_OWNER, published: 0 });
    const created = await api.request('POST', '/api/requests', { as: OTHER_OWNER, json: { tripId: otherTrip, message: '私有行程請求' } });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: number };
    await db.prepare("UPDATE trip_note_ai_jobs SET request_id = ?, timeout_at = datetime('now', '-1 second') WHERE id = ?")
      .bind(id, jobId).run();
    expect((await api.get(`/api/trips/${ownTrip}/notes/ai-state`, { as: OWNER })).status).toBe(200);
    expect(await getRequest(id, OTHER_OWNER)).toMatchObject({ status: 'open', terminalReason: null });
  });

  it('收屍讀取後 worker 恢復活動，保留其回報與等待狀態', async () => {
    const tripId = 's16-auto-wall-race';
    const id = await healthRequest(tripId);
    await ageRequest(id, 101);
    const racing = apiWith(beforeRequestUpdate(() => patchRequest(id, { status: 'processing', reply: 'worker 已恢復' })));
    expect(await getRequest(id, OWNER, racing)).toMatchObject({ status: 'processing', terminalReason: null, reply: 'worker 已恢復' });
    expect(await getHealth(tripId)).toMatchObject({ report: { status: 'pending' } });
  });

  it.each(['completed', 'failed'])('拒發 token 前 request 已先 %s，不覆寫首次終結與回覆', async (status) => {
    const id = await chatRequest(`s16-auto-consent-race-${status}`);
    const racing = apiWith(beforeRequestUpdate(() => patchRequest(id, {
      status, reply: '先完成的回報', ...(status === 'failed' ? { terminalReason: 'cancelled' } : {}),
    })));
    expect((await mint(id, racing)).status).toBe(403);
    expect(await getRequest(id)).toMatchObject({ status, reply: '先完成的回報', terminalReason: status === 'failed' ? 'cancelled' : null });
  });

  it.each(['chat', 'health'])('未授權的 %s 請求解除隊列並保留授權指引', async (kind) => {
    const tripId = `s16-auto-consent-${kind}`;
    const id = kind === 'chat' ? await chatRequest(tripId) : await healthRequest(tripId);
    expect((await mint(id, mintApi())).status).toBe(403);
    expect(await getRequest(id)).toMatchObject({ status: 'failed', terminalReason: 'needs_consent', reply: expect.stringContaining('授權並送出') });
    // 資料列本身也要真的終結（不只是回應長得像）
    const row = await db.prepare('SELECT status, terminal_reason FROM trip_requests WHERE id = ?').bind(id).first();
    expect(row).toEqual({ status: 'failed', terminal_reason: 'needs_consent' });
    if (kind === 'health') {
      expect(await getHealth(tripId)).toMatchObject({ report: { status: 'failed', errorMessage: '需要行程擁有者授權 AI 才能執行健檢' } });
    }
  });

  it('拒發時 request 寫入故障仍拒發 token，下一次可解除隊列', async () => {
    const id = await chatRequest('s16-auto-consent-write-retry');
    const denied = await mint(id, apiWith(failOnce((sql) => /UPDATE trip_requests/.test(sql))));
    expect(denied.status).toBe(403);
    expect(await denied.json()).not.toHaveProperty('access_token');
    expect(await getRequest(id)).toMatchObject({ status: 'open' });
    expect((await mint(id, mintApi())).status).toBe(403);
    expect(await getRequest(id)).toMatchObject({ status: 'failed', terminalReason: 'needs_consent' });
  });

  it('100 分鐘牆鐘也收尾筆記工作，維持筆記自己的逾時狀態', async () => {
    const tripId = 's16-auto-notes-wall';
    const { requestId, jobId } = await notesRequest(tripId);
    await ageRequest(requestId, 101);
    await db.prepare("UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-91 minutes') WHERE id = ?").bind(jobId).run();
    expect(await getRequest(requestId)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'timedOut' })]) });
  });

  it('10 分鐘收尾寫入故障不復活 request，重新讀取可恢復', async () => {
    const tripId = 's16-auto-notes-job-retry';
    const { requestId, jobId } = await notesRequest(tripId);
    await db.prepare("UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-1 second') WHERE id = ?").bind(jobId).run();
    const faulty = apiWith(failOnce((sql) => /UPDATE trip_note_ai_jobs/.test(sql)));
    expect(await getAiState(tripId, faulty)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'pending' })]) });
    expect(await getRequest(requestId)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'timedOut' })]) });
  });

  it('再次拒發受限 token 時可補做先前失敗的筆記收尾', async () => {
    const tripId = 's16-auto-consent-retry';
    const { requestId } = await notesRequest(tripId);
    expect((await mint(requestId, apiWith(failOnce((sql) => /SELECT[\s\S]*FROM trip_note_ai_jobs/.test(sql))))).status).toBe(403);
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'pending' })]) });
    expect((await mint(requestId, mintApi())).status).toBe(403);
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'failed' })]) });
  });

  it.each(['processing', 'completed'])('過期筆記收到 %s 回報時，先按期限終結且保留遲到回覆', async (status) => {
    const tripId = `s16-auto-notes-late-${status}`;
    const { requestId, jobId } = await notesRequest(tripId);
    await db.prepare("UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-1 second') WHERE id = ?").bind(jobId).run();
    const reply = JSON.stringify([{ title: '已逾時的成果', content: '不套用', section: '一般' }]);
    const response = await patchRequest(requestId, { status, reply });
    expect(await response.json()).toMatchObject({ status: 'failed', terminalReason: 'timed_out', reply });
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'timedOut' })]) });
  });

  it('筆記 10 分鐘逾時保留 timedOut 工作狀態，request 帶 timed_out 原因', async () => {
    const tripId = 's16-auto-notes-expiry';
    const { requestId, jobId } = await notesRequest(tripId);
    await db.prepare("UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-1 second') WHERE id = ?").bind(jobId).run();
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({
      requestId, status: 'timedOut', errorCode: 'NOTES_AI_JOB_STALE',
    })]) });
    expect(await getRequest(requestId)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
  });

  it('缺少授權拒發 token；健檢收尾故障不阻止筆記收尾及授權指引', async () => {
    const tripId = 's16-auto-no-consent-notes';
    const { requestId } = await notesRequest(tripId);
    const denied = await mint(requestId, apiWith(failOnce((sql) => /trip_health_reports/.test(sql))));
    expect(denied.status).toBe(403);
    expect(await denied.json()).not.toHaveProperty('access_token');
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({
      docType: 'tips', requestId, status: 'failed', errorCode: 'NOTES_AI_APPLY_FAILED',
      errorMessage: '需要行程擁有者授權 AI 才能生成',
    })]) });
    expect(await getRequest(requestId)).toMatchObject({
      status: 'failed', terminalReason: 'needs_consent', reply: expect.stringContaining('授權並送出'),
    });
  });

  it('自動終結的收尾失敗時，下一次讀取能補做且保留逾時原因', async () => {
    const tripId = 's16-auto-health-retry';
    const id = await healthRequest(tripId);
    await ageRequest(id, 101);
    const faulty = apiWith(failOnce((sql) => /UPDATE trip_health_reports/.test(sql)));
    expect(await getRequest(id, OWNER, faulty)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
    expect(await getHealth(tripId)).toMatchObject({ report: { status: 'pending' } });
    expect(await getRequest(id)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
    expect(await getHealth(tripId)).toMatchObject({ report: { status: 'failed' } });
  });

  it('100 分鐘牆鐘解除等待，也完成關聯健檢收尾', async () => {
    const tripId = 's16-auto-health-expiry';
    const id = await healthRequest(tripId);
    await ageRequest(id, 101);
    expect(await getRequest(id)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
    expect(await getHealth(tripId)).toMatchObject({ report: { status: 'failed', requestId: id } });
  });
});

// mutation 驗證補的缺口：mint 本身的授權與狀態守衛（原本只驗「拒發」的收尾，沒驗「發」與其前置條件）
describe('mint-restricted 授權與狀態守衛', () => {
  it('owner 已授權 → 簽出只能寫該行程的受限 token，request 維持 open', async () => {
    const tripId = 's16-auto-mint-ok';
    await seedUser(db, CONSENTED_OWNER);
    await new D1Adapter(db, 'Consent').upsert(
      `${userIdFor(CONSENTED_OWNER)}:${TP_REQUEST_CLIENT_ID}`,
      { user_id: userIdFor(CONSENTED_OWNER), client_id: TP_REQUEST_CLIENT_ID, scopes: ['openid'] },
      300,
    );
    await seedTrip(db, { id: tripId, days: 1, owner: CONSENTED_OWNER });
    const created = await api.request('POST', '/api/requests', { as: CONSENTED_OWNER, json: { tripId, message: '請幫我安排行程' } });
    const { id } = await created.json() as { id: number };
    const response = await mint(id, mintApi());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const token = await response.json() as Record<string, unknown>;
    expect(token).toMatchObject({ token_type: 'Bearer', restrict_trip: tripId });
    expect(typeof token.access_token).toBe('string');
    // token 是真的、綁在該 owner 與該行程上
    const stored = await new D1Adapter(db, 'AccessToken').find(token.access_token as string);
    expect(stored).toMatchObject({ user_id: userIdFor(CONSENTED_OWNER), restrict_trip: tripId, scopes: [] });
    expect(await getRequest(id, CONSENTED_OWNER)).toMatchObject({ status: 'open', terminalReason: null });
  });

  it.each([
    ['錯誤的 secret', 'Bearer wrong-secret'],
    ['沒帶 Authorization', ''],
  ])('%s → 401，request 不被動到', async (_label, header) => {
    const id = await chatRequest(`s16-auto-mint-bad-${header ? 'secret' : 'none'}`);
    const response = await mintApi().request('POST', '/api/oauth/mint-restricted', {
      headers: header ? { Authorization: header } : {}, json: { request_id: id },
    });
    expect(response.status).toBe(401);
    expect(await getRequest(id)).toMatchObject({ status: 'open', terminalReason: null });
  });

  it('request 已終結 → 403 不可 mint（即使 owner 已授權），且不改寫原終結結果', async () => {
    const tripId = 's16-auto-mint-terminal';
    await seedUser(db, CONSENTED_OWNER);
    await new D1Adapter(db, 'Consent').upsert(
      `${userIdFor(CONSENTED_OWNER)}:${TP_REQUEST_CLIENT_ID}`,
      { user_id: userIdFor(CONSENTED_OWNER), client_id: TP_REQUEST_CLIENT_ID, scopes: ['openid'] },
      300,
    );
    await seedTrip(db, { id: tripId, days: 1, owner: CONSENTED_OWNER });
    const created = await api.request('POST', '/api/requests', { as: CONSENTED_OWNER, json: { tripId, message: '請幫我安排行程' } });
    const { id } = await created.json() as { id: number };
    await patchRequest(id, { status: 'failed', terminalReason: 'cancelled', reply: '使用者停止等待' }, CONSENTED_OWNER);
    const response = await mint(id, mintApi());
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('access_token');
    expect(await getRequest(id, CONSENTED_OWNER)).toMatchObject({ status: 'failed', terminalReason: 'cancelled', reply: '使用者停止等待' });
  });

  it('缺 request_id → 400', async () => {
    const response = await mintApi().request('POST', '/api/oauth/mint-restricted', { bearer: SECRET, json: {} });
    expect(response.status).toBe(400);
  });

  it('request 不存在 → 404', async () => {
    expect((await mint(987654321, mintApi())).status).toBe(404);
  });
});

// mutation 驗證補的缺口：筆記期限掃描的邊界、processing 回報、健檢收尾冪等、權限
describe('筆記與健檢收尾的邊界', () => {
  it('PATCH processing 會把筆記 job 標成 processing', async () => {
    const tripId = 's16-auto-notes-processing';
    const { requestId } = await notesRequest(tripId);
    expect((await patchRequest(requestId, { status: 'processing' })).status).toBe(200);
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'processing' })]) });
  });

  it('期限掃描不碰已終結的 request：保留原因與空 reply，job 照自己的期限收成 timedOut', async () => {
    const tripId = 's16-auto-notes-terminal-scan';
    const { requestId, jobId } = await notesRequest(tripId);
    // 模擬：使用者已停止等待（終結），但 job 因收尾故障仍停在 pending 且已過期
    await db.prepare("UPDATE trip_requests SET status = 'failed', terminal_reason = 'cancelled' WHERE id = ?").bind(requestId).run();
    await db.prepare("UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-1 second') WHERE id = ?").bind(jobId).run();
    expect(await getAiState(tripId)).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ requestId, status: 'timedOut' })]) });
    const row = await db.prepare('SELECT status, terminal_reason, reply FROM trip_requests WHERE id = ?').bind(requestId).first();
    expect(row).toMatchObject({ status: 'failed', terminal_reason: 'cancelled' });
    expect((row as { reply: string | null }).reply).not.toBe('AI 生成超過 10 分鐘');
  });

  it('job 已被標逾時、但 request 還在等 → 下次讀取補終結 request', async () => {
    const tripId = 's16-auto-notes-job-timed-out';
    const { requestId, jobId } = await notesRequest(tripId);
    await db.prepare("UPDATE trip_note_ai_jobs SET status = 'timed_out', error_code = 'NOTES_AI_JOB_STALE' WHERE id = ?").bind(jobId).run();
    expect(await getRequest(requestId)).toMatchObject({ status: 'open' });
    await getAiState(tripId);
    expect(await getRequest(requestId)).toMatchObject({ status: 'failed', terminalReason: 'timed_out' });
  });

  it('筆記 ai-state：無該行程權限 → 403', async () => {
    const tripId = 's16-auto-notes-perm';
    await seedTrip(db, { id: tripId, days: 1, owner: OWNER });
    expect((await api.get(`/api/trips/${tripId}/notes/ai-state`, { as: OTHER_OWNER })).status).toBe(403);
  });

  it('健檢完成後再讀 request 不會重跑收尾覆蓋已套用的 findings', async () => {
    const tripId = 's16-auto-health-idempotent';
    const id = await healthRequest(tripId);
    const findings = JSON.stringify([{ severity: 'high', title: '第一天行程過滿', suggestion: '移除一個景點' }]);
    expect((await patchRequest(id, { status: 'completed', reply: findings })).status).toBe(200);
    const first = await getHealth(tripId) as { report: { status: string; findings: unknown[] } };
    expect(first.report.status).toBe('completed');
    expect(first.report.findings).toHaveLength(1);
    // 之後 reply 已被改寫成摘要；再讀（會補做收尾）不得拿摘要重新解析覆蓋 findings
    await getRequest(id);
    await getRequest(id);
    const again = await getHealth(tripId) as { report: { status: string; findings: unknown[] } };
    expect(again.report.status).toBe('completed');
    expect(again.report.findings).toHaveLength(1);
  });
});

