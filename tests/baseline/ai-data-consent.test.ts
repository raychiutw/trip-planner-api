/**
 * AI 資料同意（spec #1553 的 server 端）。唯一 seam＝HTTP 入口到真實本機 D1；只替換外部 AI（TRIPLINE_API_URL 未設，不外連）
 * 與「文案是否填妥」（vi.mock 把三個待填占位符填上，才能測強制生效的情境；真實文案未填妥的行為在 ai-data-consent-incomplete.test.ts）。
 *
 * 涵蓋：三個動作（狀態／同意／撤回）、四種狀態、雙方同意閘門（三個受管制入口）、旗標關閉＝現況、服務 token 不受閘門、
 * 撤回對排隊中請求的終結、請求列表對服務 token 的資料最小化。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, seedEntry, getDayId, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { serviceToken } from './service-token';
import { cleanupTrips } from './cleanup-trips';
import { ApiError } from '../../src/schemas/common';
import { AiConsentGateError } from '../../src/schemas/account';
import { expectContract } from '../contract/support';
import { assertAiConsent } from '../../src/lib/ai-data-consent';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

vi.mock('../../src/lib/ai-data-consent-text', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/lib/ai-data-consent-text')>();
  const fill = (s: string) => s.replaceAll('{{RESPONSIBLE_PARTY}}', '測試責任人').replaceAll('{{CONTACT_EMAIL}}', 'privacy@example.test').replaceAll('{{TERMS_URL}}', 'https://example.test/terms');
  return { ...m, CONSENT_TEXTS: Object.fromEntries(Object.entries(m.CONSENT_TEXTS).map(([k, v]) => [k, JSON.parse(fill(JSON.stringify(v)))])) };
});

const P = 'aic';
const OWNER = `${P}-owner@test.com`;
const COLLAB = `${P}-collab@test.com`;
const STRANGER = `${P}-stranger@test.com`;
const OTHER = `${P}-other@test.com`;
const TRIP = `${P}-trip`;
const V = 'ai-data-v1';
const ORIGIN = 'https://trip-planner-dby.pages.dev';

let db: D1Database;
let apiOn: Api; // 文案已填妥，閘門永遠強制
let companion: string;

const uid = userIdFor;
const events = async (email: string) =>
  (await db.prepare('SELECT id, version, event FROM ai_data_consent_events WHERE user_id = ? ORDER BY id').bind(uid(email)).all<{ id: number; version: string; event: string }>()).results;
const get = (email: string, api = apiOn) => api.get('/api/account/ai-data-consent', { as: email });
const accept = (email: string, version: unknown = V, api = apiOn) => api.request('POST', '/api/account/ai-data-consent', { as: email, json: { version } });
const withdraw = (email: string, api = apiOn) => api.request('DELETE', '/api/account/ai-data-consent', { as: email });
const seedEvent = (email: string, version: string, event: string) =>
  db.prepare('INSERT INTO ai_data_consent_events (user_id, version, event) VALUES (?, ?, ?)').bind(uid(email), version, event).run();
const clearEvents = () => db.prepare("DELETE FROM ai_data_consent_events WHERE user_id LIKE ?").bind(`test-user-${P}-%`).run();
const body = async (r: Response) => (await r.json()) as Record<string, any>;

beforeAll(async () => {
  db = await createTestDb();
  apiOn = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: ORIGIN }) });
  for (const e of [COLLAB, STRANGER, OTHER]) await seedUser(db, e);
  await seedTrip(db, { id: TRIP, owner: OWNER });
  await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'member')").bind(uid(COLLAB), TRIP).run();
  await seedEntry(db, await getDayId(db, TRIP, 1));
  companion = await serviceToken(db, ['companion']);
});

afterAll(async () => {
  await clearEvents();
  await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_health_reports WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_note_ai_jobs WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('GET /api/account/ai-data-consent', () => {
  it('未登入 → 401', async () => {
    expect((await apiOn.request('GET', '/api/account/ai-data-consent')).status).toBe(401);
  });
  it('從未同意 → none；帶目前版本、說明文字、enforced（不需旗標）', async () => {
    await clearEvents();
    const res = await get(OTHER);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toMatchObject({ status: 'none', currentVersion: V, acceptedVersion: null, acceptedAt: null, enforced: true });
    expect(b.text.version).toBe(V);
    expect(typeof b.text.title).toBe('string');
  });
});

describe('POST /api/account/ai-data-consent', () => {
  it('未登入 → 401；沒帶 version → 400；未知版本 → 409 且不寫入', async () => {
    await clearEvents();
    expect((await apiOn.request('POST', '/api/account/ai-data-consent', { headers: { Origin: ORIGIN }, json: { version: V } })).status).toBe(401);
    expect((await accept(OTHER, null)).status).toBe(400);
    expect((await apiOn.request('POST', '/api/account/ai-data-consent', { as: OTHER, json: {} })).status).toBe(400);
    const res = await accept(OTHER, 'ai-data-v999');
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe('AI_CONSENT_VERSION_MISMATCH');
    expect(b.error.currentVersion).toBe(V);
    expect(await events(OTHER)).toEqual([]);
  });
  it('有效接受 → valid，回新狀態並寫入一筆；重複同意同一版冪等（不新增事件）', async () => {
    await clearEvents();
    const res = await accept(OTHER);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toMatchObject({ status: 'valid', currentVersion: V, acceptedVersion: V });
    expect(b.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await events(OTHER)).map((e) => e.event)).toEqual(['accepted']);
    expect((await body(await accept(OTHER))).status).toBe('valid');
    expect(await events(OTHER)).toHaveLength(1);
    expect((await body(await get(OTHER))).status).toBe('valid');
  });
  it('舊版（stale）：狀態 stale 並帶出已接受的舊版；舊版號不能再被接受；接受目前版後 valid', async () => {
    await clearEvents();
    await seedEvent(OTHER, 'ai-data-v0', 'accepted');
    const g = await body(await get(OTHER));
    expect(g).toMatchObject({ status: 'stale', acceptedVersion: 'ai-data-v0', currentVersion: V });
    expect((await accept(OTHER, 'ai-data-v0')).status).toBe(409);
    expect((await body(await accept(OTHER))).status).toBe('valid');
    expect((await events(OTHER)).map((e) => `${e.version}:${e.event}`)).toEqual(['ai-data-v0:accepted', `${V}:accepted`]);
  });
  it('body 帶別人的 userId 無效：只寫呼叫者自己', async () => {
    await clearEvents();
    const res = await apiOn.request('POST', '/api/account/ai-data-consent', { as: OTHER, json: { version: V, userId: uid(STRANGER), user_id: uid(STRANGER) } });
    expect(res.status).toBe(200);
    expect(await events(STRANGER)).toEqual([]);
    expect(await events(OTHER)).toHaveLength(1);
  });
  it('同一版接受後不能被「同一帳號的舊事件」蓋過：接受 v1、撤回、再接受 → 三筆，最新是 accepted', async () => {
    await clearEvents();
    await accept(OTHER); await withdraw(OTHER);
    expect((await body(await accept(OTHER))).status).toBe('valid');
    expect((await events(OTHER)).map((e) => e.event)).toEqual(['accepted', 'withdrawn', 'accepted']);
  });
});

describe('DELETE /api/account/ai-data-consent', () => {
  it('未登入 → 401', async () => {
    expect((await apiOn.request('DELETE', '/api/account/ai-data-consent', { headers: { Origin: ORIGIN } })).status).toBe(401);
  });
  it('撤回 → withdrawn（acceptedVersion 為 null）；事件只追加；再撤回冪等', async () => {
    await clearEvents();
    await accept(OTHER);
    const res = await withdraw(OTHER);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ status: 'withdrawn', acceptedVersion: null, acceptedAt: null });
    expect((await events(OTHER)).map((e) => e.event)).toEqual(['accepted', 'withdrawn']);
    expect((await body(await withdraw(OTHER))).status).toBe('withdrawn');
    expect(await events(OTHER)).toHaveLength(2);
    expect((await body(await get(OTHER))).status).toBe('withdrawn');
  });
  it('從未同意就撤回 → 成功（冪等）、仍是 none、不寫事件', async () => {
    await clearEvents();
    const res = await withdraw(OTHER);
    expect(res.status).toBe(200);
    expect((await body(res)).status).toBe('none');
    expect(await events(OTHER)).toEqual([]);
  });
  it('舊版同意者撤回 → withdrawn', async () => {
    await clearEvents();
    await seedEvent(OTHER, 'ai-data-v0', 'accepted');
    expect((await body(await withdraw(OTHER))).status).toBe('withdrawn');
  });
});

describe('跨帳號、並行、不碰其他同意', () => {
  it('A 的同意與撤回不影響 B', async () => {
    await clearEvents();
    await accept(OWNER); await accept(COLLAB);
    await withdraw(COLLAB);
    expect((await body(await get(OWNER))).status).toBe('valid');
    expect((await body(await get(COLLAB))).status).toBe('withdrawn');
    expect((await body(await get(STRANGER))).status).toBe('none');
  });
  it('並行：多個相同同意只留一筆；同意與撤回並行，最終狀態＝最新事件，舊事件不被改寫', async () => {
    await clearEvents();
    await Promise.all([1, 2, 3, 4, 5].map(() => accept(OTHER)));
    expect(await events(OTHER)).toHaveLength(1);
    const before = await events(OTHER);
    const rs = await Promise.all([withdraw(OTHER), accept(OTHER), withdraw(OTHER), accept(OTHER)]);
    for (const r of rs) expect(r.status).toBe(200);
    const after = await events(OTHER);
    expect(after.slice(0, before.length)).toEqual(before); // 只追加
    const last = after[after.length - 1]!;
    const expected = last.event === 'accepted' ? 'valid' : 'withdrawn';
    expect((await body(await get(OTHER))).status).toBe(expected);
    for (let i = 1; i < after.length; i++) expect(after[i]!.event === after[i - 1]!.event && after[i]!.version === after[i - 1]!.version, '不應有連續重複的事件').toBe(false);
  });
  it('一般 OAuth scope 同意與 ai-authorization 不受影響：互不改動對方的狀態', async () => {
    await clearEvents();
    await db.prepare("DELETE FROM oauth_models WHERE name = 'Consent' AND id LIKE ?").bind(`test-user-${P}-%`).run();
    await new D1Adapter(db, 'Consent').upsert(`${uid(OTHER)}:some-app`, { user_id: uid(OTHER), client_id: 'some-app', scopes: ['openid'], grantedAt: 1 }, 300);
    // 有 OAuth 同意、沒有資料同意
    expect((await body(await get(OTHER))).status).toBe('none');
    // AI 操作授權不產生資料同意
    expect((await apiOn.request('POST', '/api/account/ai-authorization', { as: OTHER })).status).toBe(200);
    expect((await body(await get(OTHER))).status).toBe('none');
    expect(await events(OTHER)).toEqual([]);
    // 資料同意與撤回不動 oauth_models 的同意／操作授權
    await accept(OTHER); await withdraw(OTHER);
    expect((await (await apiOn.get('/api/account/ai-authorization', { as: OTHER })).json())).toEqual({ authorized: true });
    const c = await db.prepare("SELECT id FROM oauth_models WHERE name = 'Consent' AND id LIKE ? ORDER BY id").bind(`${uid(OTHER)}:%`).all<{ id: string }>();
    expect(c.results.map((r) => r.id)).toEqual([`${uid(OTHER)}:some-app`, `${uid(OTHER)}:tripline-tp-request`]);
    await db.prepare("DELETE FROM oauth_models WHERE name = 'Consent' AND id LIKE ?").bind(`${uid(OTHER)}:%`).run();
  });
});

// ───────── 受管制入口 ─────────

interface Entry { name: string; call: (as: string, api?: Api) => Promise<Response>; ok: number[]; count: () => Promise<number> }
const reqCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM trip_requests WHERE trip_id = ?').bind(TRIP).first<{ n: number }>())!.n;
let seq = 0;
const ENTRIES: Entry[] = [
  { name: 'POST /api/requests', ok: [201], count: reqCount,
    call: (as, api = apiOn) => api.request('POST', '/api/requests', { as, json: { tripId: TRIP, message: `請幫我排行程 ${++seq} ${Math.random()}` } }) },
  { name: 'POST /api/trips/:id/health-check', ok: [202, 200], count: reqCount,
    call: async (as, api = apiOn) => {
      await db.prepare("DELETE FROM trip_health_reports WHERE trip_id = ?").bind(TRIP).run(); // 避開 30 秒去重
      return api.request('POST', `/api/trips/${TRIP}/health-check`, { as });
    } },
  { name: 'POST /api/trips/:id/notes/:type/generate', ok: [202, 200], count: reqCount,
    call: async (as, api = apiOn) => {
      await db.prepare("DELETE FROM trip_note_ai_jobs WHERE trip_id = ?").bind(TRIP).run(); // 避開進行中 job 去重
      return api.request('POST', `/api/trips/${TRIP}/notes/tips/generate`, { as, json: {} });
    } },
];

describe.each(ENTRIES)('受管制入口：$name', (entry) => {
  const expectBlocked = async (res: Response, code: string, status: string) => {
    expect(res.status).toBe(403);
    const b = await res.json();
    expectContract(AiConsentGateError, b);
    if (code === 'AI_CONSENT_OWNER_REQUIRED') {
      // 旅伴只需知道缺的是 owner，不揭露 owner 是 none／stale／withdrawn
      expect((b as any).error).toMatchObject({ code, requiredVersion: V });
      expect((b as any).error).not.toHaveProperty('status');
      expect(JSON.stringify(b)).not.toMatch(/stale|withdrawn/);
    } else {
      expect((b as any).error).toMatchObject({ code, requiredVersion: V, status });
    }
  };
  const blockedWithoutRows = async (as: string, code: string, status: string) => {
    const before = await entry.count();
    await expectBlocked(await entry.call(as), code, status);
    expect(await entry.count(), '被擋時不得建立 request').toBe(before);
  };
  const allowed = async (as: string, api = apiOn) => {
    const before = await entry.count();
    const res = await entry.call(as, api);
    expect(entry.ok, `期望成功，實得 ${res.status}`).toContain(res.status);
    expect(await entry.count()).toBeGreaterThan(before);
  };

  it('owner 自己送、沒同意 → 403 AI_CONSENT_REQUIRED（status none），不建立 request', async () => {
    await clearEvents();
    await blockedWithoutRows(OWNER, 'AI_CONSENT_REQUIRED', 'none');
  });
  it('owner 自己送、撤回／舊版 → status withdrawn／stale', async () => {
    await clearEvents();
    await accept(OWNER); await withdraw(OWNER);
    await blockedWithoutRows(OWNER, 'AI_CONSENT_REQUIRED', 'withdrawn');
    await clearEvents();
    await seedEvent(OWNER, 'ai-data-v0', 'accepted');
    await blockedWithoutRows(OWNER, 'AI_CONSENT_REQUIRED', 'stale');
  });
  it('旅伴（共編者）直接放行：自己沒同意、owner 也沒同意都能送', async () => {
    await clearEvents();
    await allowed(COLLAB);
    await accept(OWNER); await withdraw(OWNER);
    await allowed(COLLAB);
  });
  it('owner 同意後可送出', async () => {
    await clearEvents();
    await accept(OWNER);
    await allowed(OWNER);
  });
  it('撤回後新請求立即被擋；重新同意後恢復', async () => {
    await clearEvents();
    await accept(OWNER);
    await allowed(OWNER);
    await withdraw(OWNER);
    await blockedWithoutRows(OWNER, 'AI_CONSENT_REQUIRED', 'withdrawn');
    await accept(OWNER);
    await allowed(OWNER);
  });
  it('沒有該行程寫權限的人（即使自己有同意）仍是 PERM_DENIED，不洩漏 owner 的同意狀態', async () => {
    await clearEvents();
    await accept(STRANGER);
    const res = await entry.call(STRANGER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('PERM_DENIED');
  });
  it('不需任何旗標：沒有同意的 owner 被攔 403；旅伴放行', async () => {
    await clearEvents();
    const res = await entry.call(OWNER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('AI_CONSENT_REQUIRED');
    expect(entry.ok).toContain((await entry.call(COLLAB)).status);
  });
  it('服務 token（無 userId）不套用閘門', async () => {
    await clearEvents();
    const as = async (api: Api) => {
      const r = await api.request('POST', entry.name.includes('/api/requests') ? '/api/requests' : entry.name.includes('health') ? `/api/trips/${TRIP}/health-check` : `/api/trips/${TRIP}/notes/tips/generate`, { bearer: companion, json: { tripId: TRIP, message: 'x' } });
      return { status: r.status, code: ((await r.json()) as any)?.error?.code };
    };
    expect((await as(apiOn)).code).not.toMatch(/^AI_CONSENT/);
  });
});

describe('assertAiConsent（共用模組）', () => {
  const env = () => mockEnv(db);
  it('服務 token／無 userId 的 auth 直接放行，連 DB 都不查', async () => {
    const boom = { prepare: () => { throw new Error('不應查 DB'); } } as unknown as D1Database;
    for (const auth of [
      { email: 'service:x', userId: null, isServiceToken: true },
      { email: 'x@y.z', userId: null, isServiceToken: false },
    ]) await expect(assertAiConsent({ ...env(), DB: boom }, auth, TRIP)).resolves.toBeUndefined();
  });
  it('isServiceToken 為 true 就豁免，即使帶了 userId（防禦性：以旗標判斷，不只靠 userId 為空）', async () => {
    const boom = { prepare: () => { throw new Error('不應查 DB'); } } as unknown as D1Database;
    await expect(assertAiConsent({ ...env(), DB: boom }, { email: 'service:x', userId: 'u', isServiceToken: true }, TRIP)).resolves.toBeUndefined();
  });
  it('一般使用者一定查 DB（閘門不再有旗標短路）', async () => {
    const boom = { prepare: () => { throw new Error('查了 DB'); } } as unknown as D1Database;
    await expect(assertAiConsent({ ...env(), DB: boom }, { email: 'a@b.c', userId: 'u', isServiceToken: false }, TRIP)).rejects.toThrow('查了 DB');
  });
});

// ───────── 撤回對排隊中請求的終結（ADR-0007 語意） ─────────

describe('撤回：排隊中尚未開始的請求被終結', () => {
  const insertReq = async (email: string, status: string) =>
    (await db.prepare("INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id").bind(TRIP, `q-${status}-${Math.random()}`, email, status).first<{ id: number }>())!.id;
  const row = (id: number) => db.prepare('SELECT status, terminal_reason FROM trip_requests WHERE id = ?').bind(id).first<{ status: string; terminal_reason: string | null }>();

  it('送出者撤回：自己 open 的被終結（failed／cancelled）；processing 與別人的不動', async () => {
    await clearEvents();
    await accept(COLLAB);
    const mineOpen = await insertReq(COLLAB, 'open');
    const mineProcessing = await insertReq(COLLAB, 'processing');
    const ownerOpen = await insertReq(OWNER, 'open');
    await withdraw(COLLAB);
    expect(await row(mineOpen)).toEqual({ status: 'failed', terminal_reason: 'cancelled' });
    expect((await row(mineProcessing))!.status).toBe('processing');
    expect((await row(ownerOpen))!.status).toBe('open');
  });
  it('owner 撤回：旅伴在 owner 行程上排隊中的請求也被終結', async () => {
    await clearEvents();
    await accept(OWNER);
    const collabOpen = await insertReq(COLLAB, 'open');
    await withdraw(OWNER);
    expect(await row(collabOpen)).toEqual({ status: 'failed', terminal_reason: 'cancelled' });
  });
  it('被終結的請求帶說明（AI 資料同意已撤回），不是預設的「已停止等待」', async () => {
    await clearEvents();
    await accept(COLLAB);
    const id = await insertReq(COLLAB, 'open');
    await withdraw(COLLAB);
    const r = await db.prepare('SELECT status, reply FROM trip_requests WHERE id = ?').bind(id).first<{ status: string; reply: string | null }>();
    expect(r!.status).toBe('failed');
    expect(r!.reply).toContain('AI 資料同意已撤回');
  });
  it('重試撤回（已是 withdrawn）也會清掉殘留的排隊請求', async () => {
    await clearEvents();
    await accept(COLLAB); await withdraw(COLLAB);
    const leftover = await insertReq(COLLAB, 'open');
    await withdraw(COLLAB);
    expect(await row(leftover)).toEqual({ status: 'failed', terminal_reason: 'cancelled' });
  });
  it('從未同意者「撤回」不終結任何請求', async () => {
    await clearEvents();
    const open = await insertReq(OTHER, 'open');
    await withdraw(OTHER);
    expect((await row(open))!.status).toBe('open');
  });
});

// ───────── 資料最小化 ─────────

describe('GET /api/requests：對服務 token 省略 submittedBy（email）', () => {
  let svc: string;
  let reqId: number;
  beforeAll(async () => {
    svc = await serviceToken(db, ['ops:trips:read', 'companion']);
    reqId = (await db.prepare("INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, 'min-1', ?) RETURNING id").bind(TRIP, OWNER).first<{ id: number }>())!.id;
  });
  it('服務 token：列表（陣列與分頁兩種形狀）沒有 submittedBy，仍有 submittedByDisplayName', async () => {
    // 這裡測的是不帶 tripId 的全域列表（ops:trips:read）。帶 tripId 時 hasPermission 對服務 token 仍恆 false，
    // 但列表 handler 對持有 ops:trips:read 的服務 token 另行放行（#1662），見 tests/contract/requests-ops.contract.test.ts。
    const arr = await (await apiOn.request('GET', '/api/requests', { bearer: svc })).json() as Array<Record<string, unknown>>;
    expect(arr.length).toBeGreaterThan(0);
    for (const r of arr) { expect(r).not.toHaveProperty('submittedBy'); expect(r).toHaveProperty('submittedByDisplayName'); }
    const noTrip = await (await apiOn.request('GET', '/api/requests?limit=50', { bearer: svc })).json() as { items: Array<Record<string, unknown>> };
    expect(noTrip.items.length).toBeGreaterThan(0);
    for (const r of noTrip.items) expect(r).not.toHaveProperty('submittedBy');
    expect(JSON.stringify(arr)).not.toContain('@test.com');
  });
  it('一般使用者：回應完全不變（仍含 submittedBy 與 submittedByDisplayName）', async () => {
    const arr = await (await apiOn.get(`/api/requests?tripId=${TRIP}`, { as: OWNER })).json() as Array<Record<string, unknown>>;
    const mine = arr.find((r) => r.id === reqId)!;
    expect(mine.submittedBy).toBe(OWNER);
    expect(mine.submittedByDisplayName).toBe(OWNER.split('@')[0]);
    const one = await (await apiOn.get(`/api/requests/${reqId}`, { as: OWNER })).json() as Record<string, unknown>;
    expect(one.submittedBy).toBe(OWNER);
    expect(one.submittedByDisplayName).toBe(OWNER.split('@')[0]);
  });
  it('restrict_trip 的使用者 token（agent 的 MCP 實際用的）：列表與單筆都沒有 submittedBy，仍有 submittedByDisplayName', async () => {
    const restricted = await apiOn.tokenFor(OWNER, ['trips:read', 'trips:write'], { restrictTrip: TRIP });
    const arr = await (await apiOn.request('GET', `/api/requests?tripId=${TRIP}`, { bearer: restricted })).json() as Array<Record<string, unknown>>;
    expect(arr.length).toBeGreaterThan(0);
    for (const r of arr) { expect(r).not.toHaveProperty('submittedBy'); expect(r).toHaveProperty('submittedByDisplayName'); }
    const page = await (await apiOn.request('GET', `/api/requests?tripId=${TRIP}&limit=50`, { bearer: restricted })).json() as { items: Array<Record<string, unknown>> };
    for (const r of page.items) expect(r).not.toHaveProperty('submittedBy');
    const one = await apiOn.request('GET', `/api/requests/${reqId}`, { bearer: restricted });
    expect(one.status).toBe(200);
    const ob = await one.json() as Record<string, unknown>;
    expect(ob).not.toHaveProperty('submittedBy');
    expect(ob.submittedByDisplayName).toBe(OWNER.split('@')[0]);
    expect(JSON.stringify([arr, page, ob])).not.toContain('@test.com');
  });
  it('GET /api/requests/:id 對服務 token 仍是 403（沒有任何 email 外洩路徑）', async () => {
    const res = await apiOn.request('GET', `/api/requests/${reqId}`, { bearer: svc });
    expect(res.status).toBe(403);
    expectContract(ApiError, await res.json());
  });
});

describe('帳號刪除（eraseUserAccount）明確清掉同意事件，不單靠 FK cascade', () => {
  it('tablesCleared 含 ai_data_consent_events，且該人的事件被清空、別人的保留', async () => {
    await clearEvents();
    await seedEvent(STRANGER, 'ai-data-v1', 'accepted');
    await seedEvent(OTHER, 'ai-data-v1', 'accepted');
    const { eraseUserAccount } = await import('../../src/lib/erasure');
    const summary = await eraseUserAccount(db, uid(STRANGER));
    expect(summary.tablesCleared.ai_data_consent_events).toBe(1);
    expect(await events(STRANGER)).toEqual([]);
    expect(await events(OTHER)).toHaveLength(1);
    await seedUser(db, STRANGER);
    await clearEvents();
  });
});
