/**
 * Integration test — GET/POST /api/requests + PATCH /api/requests/:id
 * 走 HTTP 邊界（tests/api/http.ts）：user 用真實 bearer token，companion 用 client_credentials 式的
 * service token（user_id=null、scope=companion）；狀態變化一律讀真實資料列。
 * 共用 D1：專用 trip id／email（s16-req-），結束時清掉自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';
import { cleanupTrips } from './cleanup-trips';

const TRIP = 's16-req-trip';
const OWNER = 's16-req-owner@test.com';
const STRANGER = 's16-req-stranger@test.com';
// 匿名的瀏覽器寫入請求會帶 Origin；沒帶會先被 CSRF 檢查擋成 403，到不了 401
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';

let db: D1Database;
let api: Api;
let companion: string;
let requestId: number;

const patchReq = (id: number | string, json: unknown, bearer: string) =>
  api.request('PATCH', `/api/requests/${id}`, { json, bearer });
const getOne = (id: number | string, as = OWNER) => api.get(`/api/requests/${id}`, { as });
async function seedUserId(email: string): Promise<string> {
  const id = userIdFor(email);
  await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(id, email, email.split('@')[0]).run();
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' }) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
  companion = await serviceToken(db, ['companion']);
});

afterAll(async () => {
  await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('POST /api/requests', () => {
  it('建立請求 → 201', async () => {
    const resp = await api.request('POST', '/api/requests', {
      as: OWNER,
      json: { tripId: TRIP, mode: 'trip-edit', message: '請幫我加一間餐廳' },
    });
    expect(resp.status).toBe(201);
    const data = await resp.json() as Record<string, unknown>;
    requestId = data.id as number;
    expect(data.status).toBe('open');
    // 真實資料列：歸屬行程、送出者、訊息
    const row = await db.prepare('SELECT trip_id, submitted_by, message, status FROM trip_requests WHERE id = ?')
      .bind(requestId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ trip_id: TRIP, submitted_by: OWNER, message: '請幫我加一間餐廳', status: 'open' });
  });

  it('mode rip-out phase 2: response shape 不含 mode (migration 0049 DROP COLUMN)', async () => {
    const resp = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: '幫我推薦景點' } });
    expect(resp.status).toBe(201);
    const data = await resp.json() as Record<string, unknown>;
    expect(data).not.toHaveProperty('mode');
  });

  it('缺 message → 400', async () => {
    const resp = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP } });
    expect(resp.status).toBe(400);
  });

  it('未認證 → 401', async () => {
    const resp = await api.request('POST', '/api/requests', {
      headers: { Origin: BROWSER_ORIGIN },
      json: { tripId: TRIP, mode: 'trip-edit', message: 'hi' },
    });
    expect(resp.status).toBe(401);
  });

  // 30 秒去重只擋「仍在跑」的請求；終結狀態不得遮蔽合法重送（adversarial F1）。
  it('dedupe 仍擋 30 秒內重複的 open 請求（同訊息雙擊 → 200 回同一筆）', async () => {
    const msg = '幫我找拉麵店';
    const mk = () => api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: msg } }); // owner（有寫權）
    const a = await mk();
    expect(a.status).toBe(201);
    const aId = (await a.json() as Record<string, unknown>).id;
    const b = await mk();
    expect(b.status).toBe(200); // dedupe：回同一筆 open
    expect((await b.json() as Record<string, unknown>).id).toBe(aId);
    const rows = await db.prepare('SELECT COUNT(*) AS c FROM trip_requests WHERE trip_id = ? AND message = ?').bind(TRIP, msg).first<{ c: number }>();
    expect(rows!.c).toBe(1);
  });

  it('park 成 failed 的請求不遮蔽合法重送 → 建新 open 請求（adversarial F1 回歸）', async () => {
    const msg = '幫我排三天兩夜溫泉';
    const mk = () => api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: msg } });
    // 1. 首次送出 → open 請求
    const first = await mk();
    expect(first.status).toBe(201);
    const firstId = (await first.json() as Record<string, unknown>).id as number;
    // 2. 模擬 mint-restricted 未授權 park：標成 failed
    await db.prepare("UPDATE trip_requests SET status = 'failed' WHERE id = ?").bind(firstId).run();
    // 3. 授權後重送同一訊息（30 秒內）→ 不得 dedupe 回 failed，要建新的 open 請求
    const resend = await mk();
    expect(resend.status).toBe(201); // 非 200 dedupe 回舊 failed
    const resendData = await resend.json() as Record<string, unknown>;
    expect(resendData.id).not.toBe(firstId);
    expect(resendData.status).toBe('open');
  });

  // mutation 驗證補的缺口
  it('無寫權的人不能代 owner 送請求 → 403，不留資料列', async () => {
    const msg = 's16-req 陌生人訊息';
    const resp = await api.request('POST', '/api/requests', { as: STRANGER, json: { tripId: TRIP, message: msg } });
    expect(resp.status).toBe(403);
    const rows = await db.prepare('SELECT COUNT(*) AS c FROM trip_requests WHERE message = ?').bind(msg).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  it('dedupe 只限同一位送出者：共編成員送同樣訊息不會被併成 owner 的那筆', async () => {
    const MEMBER = 's16-req-member@test.com';
    const memberId = await seedUserId(MEMBER);
    await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'member')").bind(memberId, TRIP).run();
    const msg = 's16-req 共編同訊息';
    const a = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: msg } });
    const b = await api.request('POST', '/api/requests', { as: MEMBER, json: { tripId: TRIP, message: msg } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await b.json() as { id: number }).id).not.toBe((await a.json() as { id: number }).id);
  });

  it('建立請求寫一筆 insert 稽核（changed_by 為送出者）', async () => {
    const msg = 's16-req 稽核訊息';
    const resp = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: msg } });
    const id = (await resp.json() as { id: number }).id;
    const audit = await db.prepare("SELECT action, changed_by FROM audit_log WHERE trip_id = ? AND table_name = 'trip_requests' AND record_id = ?")
      .bind(TRIP, id).first<{ action: string; changed_by: string }>();
    expect(audit).toEqual({ action: 'insert', changed_by: OWNER });
  });
});

describe('GET /api/requests', () => {
  it('列出請求', async () => {
    const resp = await api.get(`/api/requests?tripId=${TRIP}`, { as: OWNER });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.every((r) => r.tripId === TRIP)).toBe(true);
  });

  it('只列出指定行程的請求，不混入同一位使用者在別的行程的請求', async () => {
    const OTHER = 's16-req-other-trip';
    await seedTrip(db, { id: OTHER, owner: OWNER, days: 1 });
    try {
      await db.prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?)').bind(OTHER, 's16-req 別的行程訊息', OWNER).run();
      const resp = await api.get(`/api/requests?tripId=${TRIP}`, { as: OWNER });
      const data = await resp.json() as Array<Record<string, unknown>>;
      expect(data.some((r) => r.message === 's16-req 別的行程訊息')).toBe(false);
      const other = await (await api.get(`/api/requests?tripId=${OTHER}`, { as: OWNER })).json() as Array<Record<string, unknown>>;
      expect(other.map((r) => r.message)).toEqual(['s16-req 別的行程訊息']);
    } finally {
      await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(OTHER).run();
      await cleanupTrips(db, [OTHER]);
    }
  });

  it('未認證 → 401', async () => {
    const resp = await api.get(`/api/requests?tripId=${TRIP}`);
    expect(resp.status).toBe(401);
  });

  it('無該行程權限 → 403；缺 tripId → 400', async () => {
    expect((await api.get(`/api/requests?tripId=${TRIP}`, { as: STRANGER })).status).toBe(403);
    expect((await api.get('/api/requests', { as: OWNER })).status).toBe(400);
  });
});

describe('PATCH /api/requests/:id', () => {
  async function seedRequest(message: string, submittedBy = OWNER): Promise<number> {
    const row = await db.prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING id')
      .bind(TRIP, message, submittedBy).first<{ id: number }>();
    return row!.id;
  }

  it.each(['open', 'processing', 'completed', 'failed'])('accepts current status %s through the real PATCH and GET endpoints', async (status) => {
    const id = await seedRequest('status validation ' + status);
    const response = await patchReq(id, { status }, companion);
    expect(response.status).toBe(200);
    const read = await getOne(id);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ status });
  });

  it.each(['closed', 'received', 'invalid'])('rejects retired or unknown status %s without changing the request', async (status) => {
    const id = await seedRequest('invalid status ' + status);
    const response = await patchReq(id, { status }, companion);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
    // 訊息要指出值域錯誤，而不是被「不可退回」之類的別條規則碰巧擋下
    expect(JSON.stringify(body)).toContain('status 必須是');
    const read = await getOne(id);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ status: 'open' });
  });

  it('service token（companion scope）回覆請求 → 200', async () => {
    const response = await patchReq(requestId, { reply: '已新增餐廳', status: 'completed' }, companion);
    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data.status).toBe('completed');
    const row = await db.prepare('SELECT status, reply FROM trip_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'completed', reply: '已新增餐廳' });
  });

  it('sanitizeReply 過濾敏感內容', async () => {
    const id = await seedRequest('test');
    const response = await patchReq(id, { reply: '請用 /api/trips 端點操作', status: 'completed' }, companion);
    const data = await response.json() as Record<string, unknown>;
    expect(data.reply).toBe('已處理您的請求。如有問題請直接聯繫行程主人。');
    const row = await db.prepare('SELECT reply FROM trip_requests WHERE id = ?').bind(id).first<{ reply: string }>();
    expect(row!.reply).toBe('已處理您的請求。如有問題請直接聯繫行程主人。');
  });

  // v2.55.56: PATCH gate 放寬成 companion service token OR 對該 trip 有寫權的 user
  // （restrict_trip-scoped tp-request agent 回覆自己 trip 的請求；status/reply 也吃 trip scope）。
  it('trip owner（有寫權 user，無 companion scope）回覆自己 trip 的請求 → 200', async () => {
    const id = await seedRequest('owner 回覆測試');
    const response = await api.request('PATCH', `/api/requests/${id}`, { as: OWNER, json: { reply: '好的，已處理' } });
    expect(response.status).toBe(200);
    const row = await db.prepare('SELECT reply FROM trip_requests WHERE id = ?').bind(id).first<{ reply: string }>();
    expect(row!.reply).toBe('好的，已處理');
  });

  it('無寫權 user（非 companion、非該 trip 成員）→ 403', async () => {
    const response = await api.request('PATCH', `/api/requests/${requestId}`, { as: STRANGER, json: { status: 'completed' } });
    expect(response.status).toBe(403);
  });

  // mutation 驗證補的缺口：純維運 token（無 companion）不得回覆；找不到 → 404
  it('只有 ops:maps 的 service token（無 companion）→ 403，請求不變', async () => {
    const id = await seedRequest('ops 只讀 token');
    const opsOnly = await serviceToken(db, ['ops:maps']);
    const response = await patchReq(id, { status: 'completed', reply: '不該寫進去' }, opsOnly);
    expect(response.status).toBe(403);
    const row = await db.prepare('SELECT status, reply FROM trip_requests WHERE id = ?').bind(id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'open', reply: null });
  });

  it('PATCH 寫稽核（update、changed_by 為呼叫者、diff 含新舊 status）並更新 updated_at', async () => {
    const id = await seedRequest('s16-req patch 稽核');
    const before = await db.prepare('SELECT updated_at FROM trip_requests WHERE id = ?').bind(id).first<{ updated_at: string | null }>();
    expect(before!.updated_at).toBeNull();
    expect((await api.request('PATCH', `/api/requests/${id}`, { as: OWNER, json: { status: 'processing' } })).status).toBe(200);
    const row = await db.prepare('SELECT updated_at FROM trip_requests WHERE id = ?').bind(id).first<{ updated_at: string | null }>();
    expect(row!.updated_at).not.toBeNull();
    const audit = await db.prepare("SELECT action, changed_by, diff_json FROM audit_log WHERE trip_id = ? AND table_name = 'trip_requests' AND record_id = ? AND action = 'update'")
      .bind(TRIP, id).first<{ action: string; changed_by: string; diff_json: string }>();
    expect(audit).toMatchObject({ action: 'update', changed_by: OWNER });
    expect(JSON.parse(audit!.diff_json)).toEqual({ status: { old: 'open', new: 'processing' } });
  });

  it('沒有任何可更新欄位 → 400', async () => {
    const id = await seedRequest('s16-req 空 patch');
    const response = await patchReq(id, {}, companion);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('沒有要更新的欄位');
  });

  it('不存在的 request → 404', async () => {
    expect((await patchReq(987654321, { status: 'completed' }, companion)).status).toBe(404);
  });

  // v2.33.104 T-5：status 推進 monotonicity — 不可從 completed 回退到 open/processing
  describe('status monotonicity (T-5)', () => {
    let monoReqId: number;

    beforeAll(async () => {
      monoReqId = await seedRequest('監測 monotonicity');
    });

    it('open → completed 允許', async () => {
      expect((await patchReq(monoReqId, { status: 'completed' }, companion)).status).toBe(200);
    });

    it('completed → open 拒絕 400', async () => {
      const resp = await patchReq(monoReqId, { status: 'open' }, companion);
      expect(resp.status).toBe(400);
      const data = await resp.json() as { error?: { message?: string } };
      expect(JSON.stringify(data)).toContain('不可從');
      const row = await db.prepare('SELECT status FROM trip_requests WHERE id = ?').bind(monoReqId).first<{ status: string }>();
      expect(row!.status).toBe('completed');
    });

    it('completed → processing 拒絕 400', async () => {
      expect((await patchReq(monoReqId, { status: 'processing' }, companion)).status).toBe(400);
    });

    it('completed 後收到 failed 仍回 200，保留首次完成狀態', async () => {
      const response = await patchReq(monoReqId, { status: 'failed' }, companion);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'completed', terminalReason: null });
    });

    it('未知 status value 拒絕 400', async () => {
      expect((await patchReq(monoReqId, { status: 'invalid' }, companion)).status).toBe(400);
    });
  });
});

// ADR-0007：終結原因獨立成欄。status 說「結束了沒」，terminal_reason 說「為什麼」。
describe('終結原因 terminal_reason (ADR-0007)', () => {
  async function newRequest(message: string): Promise<number> {
    const row = await db.prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING id')
      .bind(TRIP, message, OWNER).first<{ id: number }>();
    return row!.id;
  }

  const patch = (id: number, body: Record<string, unknown>) =>
    api.request('PATCH', `/api/requests/${id}`, { as: OWNER, json: body });

  async function stored(id: number) {
    return db.prepare('SELECT status, terminal_reason, reply FROM trip_requests WHERE id = ?')
      .bind(id).first<{ status: string; terminal_reason: string | null; reply: string | null }>();
  }

  it('停止等待：標 failed + cancelled → 200，回傳帶 terminalReason', async () => {
    const id = await newRequest('停止等待測試');
    const resp = await patch(id, { status: 'failed', terminalReason: 'cancelled' });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.terminalReason).toBe('cancelled');
    expect(await stored(id)).toMatchObject({ status: 'failed', terminal_reason: 'cancelled' });
  });

  // 取消不會叫停 worker（entries/days 走 owner 身份 token，不受 companion gate 約束）。
  // 它做完仍會回報 —— 那份交代必須寫得進來，否則使用者只看到行程被改、零說明。
  it('遲到完成：終結後 worker 回報 → reply 寫得進來，status 不復活', async () => {
    const id = await newRequest('遲到完成測試');
    await patch(id, { status: 'failed', terminalReason: 'cancelled' });

    const resp = await patch(id, { status: 'completed', reply: '已加入沖繩美麗海水族館' });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.terminalReason).toBe('cancelled');
    expect(data.reply).toContain('美麗海水族館');
    expect(await stored(id)).toMatchObject({ status: 'failed', terminal_reason: 'cancelled', reply: '已加入沖繩美麗海水族館' });
  });

  it('遲到完成只送 status（無 reply）→ 200 no-op，不是「沒有要更新的欄位」', async () => {
    const id = await newRequest('遲到完成純 status');
    await patch(id, { status: 'failed', terminalReason: 'timed_out' });

    const resp = await patch(id, { status: 'completed' });
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.terminalReason).toBe('timed_out');
  });

  it('未知 terminalReason 拒絕 400', async () => {
    const id = await newRequest('未知終結原因');
    const resp = await patch(id, { status: 'failed', terminalReason: 'because-i-said-so' });
    expect(resp.status).toBe(400);
    expect(await stored(id)).toMatchObject({ status: 'open', terminal_reason: null });
  });

  it('重複終結保留第一次停止等待的原因，遲到回覆仍可讀回', async () => {
    const id = await newRequest('首次終結原因');
    await patch(id, { status: 'failed', terminalReason: 'cancelled' });
    const response = await patch(id, { status: 'failed', terminalReason: 'timed_out', reply: '已完成整理' });
    expect(response.status).toBe(200);
    const reread = await getOne(id);
    expect(await reread.json()).toMatchObject({
      status: 'failed', terminalReason: 'cancelled', reply: '已完成整理',
    });
  });
});

// ADR-0007 第二層：牆鐘兜底。api-server 自己掛掉／mac mini 離線時沒人收屍，
// 由有人在打的 read path 就地收。100 分鐘 > ORPHAN_MAX_AGE_MS(90min)，健康 session
// 還在工作時絕不會被標終結（短於它就重演 #237）。
describe('牆鐘收屍 (ADR-0007)', () => {
  async function seedAged(message: string, status: string, minutesAgo: number, useUpdatedAt: boolean): Promise<number> {
    const row = await db.prepare(
      `INSERT INTO trip_requests (trip_id, message, submitted_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now', ?), NULL) RETURNING id`
    ).bind(TRIP, message, OWNER, status, `-${minutesAgo} minutes`).first<{ id: number }>();
    if (useUpdatedAt) {
      await db.prepare(`UPDATE trip_requests SET updated_at = datetime('now', ?) WHERE id = ?`)
        .bind(`-${minutesAgo} minutes`, row!.id).run();
    }
    return row!.id;
  }

  it('processing 停滯 101 分鐘 → GET 就地標 failed + timed_out', async () => {
    const id = await seedAged('殭屍 101 分鐘', 'processing', 101, true);
    const resp = await getOne(id);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.terminalReason).toBe('timed_out');

    const row = await db.prepare('SELECT status, terminal_reason FROM trip_requests WHERE id = ?')
      .bind(id).first<{ status: string; terminal_reason: string | null }>();
    expect(row!.status).toBe('failed');
    expect(row!.terminal_reason).toBe('timed_out');
  });

  it('從未被 PATCH 過（updated_at 為 NULL）也算齡 → 用 created_at 收', async () => {
    const id = await seedAged('殭屍 never-patched', 'open', 120, false);
    const resp = await getOne(id);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.terminalReason).toBe('timed_out');
  });

  it('停滯 89 分鐘 → 不動（健康 session 還在工作，短於 orphan cap 絕不誤殺）', async () => {
    const id = await seedAged('工作中 89 分鐘', 'processing', 89, true);
    const resp = await getOne(id);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('processing');
    expect(data.terminalReason).toBeNull();
  });

  it('已終結的 request 不被牆鐘覆寫原因', async () => {
    const id = await seedAged('久遠的已完成', 'completed', 500, true);
    const resp = await getOne(id);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.status).toBe('completed');
    expect(data.terminalReason).toBeNull();
  });

  // mutation 驗證補的缺口：沒讀取權限的人不能觸發收屍（收屍是寫入）
  it('無權限的人 GET → 403，且不觸發收屍（資料列不變）', async () => {
    const id = await seedAged('殭屍 無權限讀', 'processing', 101, true);
    const resp = await getOne(id, STRANGER);
    expect(resp.status).toBe(403);
    const row = await db.prepare('SELECT status, terminal_reason FROM trip_requests WHERE id = ?')
      .bind(id).first<{ status: string; terminal_reason: string | null }>();
    expect(row).toEqual({ status: 'processing', terminal_reason: null });
  });
});
