/**
 * Integration tests — applyNotesGenerationCompletion hook into PATCH /api/requests/:id
 *
 * v2.34.x 行程筆記 PR10. Verify:
 *   - PATCH /requests/:id status=completed + linkage exists → INSERT rows in target table
 *   - PATCH status=failed → UPDATE trip_note_ai_jobs.status=failed + error_message
 *   - Dedup: existing title/name skipped
 *   - PATCH /requests/:id without notes linkage → no side effect (health-check / chat still works)
 *   - lodging-tips → ai_source='lodging-tips' in trip_pretrip_notes
 *   - tips → ai_source='general-tips' (different from lodging-tips!)
 *   - emergency → trip_emergency_contacts with kind narrowed
 *   - trip_requests.reply rewritten to user-friendly summary
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser } from './helpers';
import { createApi, type Api } from './http';
import { cleanupNotes } from './cleanup-notes';
import { serviceTokenFor } from './service-token';
import type { Env } from '../../src/env';

// 共用 D1：行程、email 用 `s14-hook` 專屬前綴，afterAll 清掉自己的資料
const PREFIX = 's14-hook';
let db: D1Database;
let env: Env;
let api: Api;
let serviceToken: string;
const TRIP_A = `${PREFIX}-trip-a`;
const tripId = TRIP_A;
const ownerEmail = `${PREFIX}-owner@hook.test`;

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  await seedUser(db, ownerEmail);
  await seedTrip(db, { id: tripId, owner: ownerEmail });
  serviceToken = await serviceTokenFor(db, { clientId: 's14-cli', scopes: ['companion'] });
});

afterAll(async () => {
  await cleanupNotes(db, PREFIX);
  await disposeMiniflare();
});

async function createJobAndRequest(docType: 'lodging-tips' | 'tips' | 'emergency', tripId = TRIP_A): Promise<{ requestId: number; jobId: number }> {
  const req = await db
    .prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING id')
    .bind(tripId, `[行程筆記-${docType}] test`, ownerEmail)
    .first<{ id: number }>();
  const job = await db
    .prepare('INSERT INTO trip_note_ai_jobs (request_id, trip_id, doc_type) VALUES (?, ?, ?) RETURNING id')
    .bind(req!.id, tripId, docType)
    .first<{ id: number }>();
  return { requestId: req!.id, jobId: job!.id };
}

/** Phase 3：PATCH /requests/:id 由帶 companion scope 的 service token 執行（Claude CLI）；`target` 可換成注入故障的 api。 */
function callPatch(requestId: number, body: Record<string, unknown>, target: Api = api) {
  return target.request('PATCH', `/api/requests/${requestId}`, { bearer: serviceToken, json: body });
}

/** 以行程 owner 的身分讀取（HTTP 邊界）。 */
function asOwner(path: string) {
  return api.request('GET', path, { as: ownerEmail });
}

async function readTrip(kind: 'ai-state' | 'notes', id = tripId) {
  const response = await asOwner(kind === 'notes' ? `/api/trips/${id}/notes` : `/api/trips/${id}/notes/ai-state`);
  return response.json() as Promise<Record<string, unknown>>;
}

const getAiState = 'ai-state' as const;
const getNotes = 'notes' as const;

function failDatabaseOnce(operation: 'prepare' | 'batch', match: (sql: string) => boolean = () => true): Api {
  let failed = false;
  const faultyDb = new Proxy(db, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (!failed && property === operation && match(String(args[0]))) {
          failed = true;
          throw new Error('Injected database outage');
        }
        return Reflect.apply(member, target, args);
      };
    },
  });
  return createApi({ env: mockEnv(faultyDb) });
}

describe('PATCH /requests/:id — notes generation completion hook', () => {
  it('舊 generation 的遲到回報不覆寫新 generation 的筆記', async () => {
    const id = `${PREFIX}-terminal-generations`;
    await seedTrip(db, { id, owner: ownerEmail });
    const generate = async () => {
      const response = await api.request('POST', `/api/trips/${id}/notes/tips/generate`, { as: ownerEmail });
      expect(response.status).toBe(202);
      return response.json() as Promise<{ requestId: number; generation: number }>;
    };
    const old = await generate();
    expect(old.generation).toBe(1);
    await callPatch(old.requestId, { status: 'failed', terminalReason: 'cancelled' });
    const current = await generate();
    expect(current.generation).toBe(2);
    await callPatch(current.requestId, {
      status: 'completed', reply: JSON.stringify([{ title: '第二版', content: '新成果', section: '一般' }]),
    });
    const saved = await readTrip(getNotes, id);
    expect(saved.pretripNotes).toContainEqual(expect.objectContaining({ title: '第二版', content: '新成果' }));
    const lateReply = JSON.stringify([{ title: '第一版', content: '過時成果', section: '一般' }]);
    await callPatch(old.requestId, { status: 'completed', reply: lateReply });
    expect((await readTrip(getNotes, id)).pretripNotes).toEqual(saved.pretripNotes);
    expect((await readTrip(getAiState, id)).jobs).toContainEqual(expect.objectContaining({ generation: 2, status: 'completed' }));
    const late = await asOwner(`/api/requests/${old.requestId}`);
    expect(await late.json()).toMatchObject({ status: 'failed', terminalReason: 'cancelled', reply: lateReply });
  });

  it('筆記寫入暫時失敗可重送完成通知，成功後不重複套用', async () => {
    const { requestId } = await createJobAndRequest('tips');
    const faulty = failDatabaseOnce('batch');
    expect((await callPatch(requestId, {
      status: 'completed', reply: JSON.stringify([{ title: '雨具', content: '準備雨衣', section: '裝備' }]),
    }, faulty)).status).toBe(200);
    expect((await readTrip(getAiState)).jobs).toContainEqual(expect.objectContaining({
      requestId, status: 'pending', errorCode: 'NOTES_AI_APPLY_FAILED',
    }));
    await callPatch(requestId, { status: 'completed' });
    const first = await readTrip(getNotes);
    expect(first.pretripNotes).toContainEqual(expect.objectContaining({ title: '雨具', content: '準備雨衣' }));
    await callPatch(requestId, { status: 'completed' });
    expect((await readTrip(getNotes)).pretripNotes).toEqual(first.pretripNotes);
    expect((await readTrip(getAiState)).jobs).toContainEqual(expect.objectContaining({
      requestId, status: 'completed', insertedCount: 1, errorCode: null,
    }));
  });

  it('停止等待後收尾失敗，遲到的純 status 通知可補做收尾', async () => {
    const { requestId } = await createJobAndRequest('tips');
    const faulty = failDatabaseOnce('prepare', (sql) => /SELECT[\s\S]*FROM trip_note_ai_jobs/.test(sql));
    expect((await callPatch(requestId, { status: 'failed', terminalReason: 'cancelled' }, faulty)).status).toBe(200);
    expect((await readTrip(getAiState)).jobs).toContainEqual(expect.objectContaining({ requestId, status: 'pending' }));
    expect((await callPatch(requestId, { status: 'completed' })).status).toBe(200);
    expect((await readTrip(getAiState)).jobs).toContainEqual(expect.objectContaining({ requestId, status: 'failed' }));
    const request = await asOwner(`/api/requests/${requestId}`);
    expect(await request.json()).toMatchObject({ status: 'failed', terminalReason: 'cancelled' });
  });

  it('健檢關聯讀取失敗仍終結 request，並獨立完成筆記', async () => {
    const { requestId } = await createJobAndRequest('tips');
    const faulty = failDatabaseOnce('prepare', (sql) => /SELECT[\s\S]*FROM trip_health_reports/.test(sql));
    const response = await callPatch(requestId, {
      status: 'completed', reply: JSON.stringify([{ title: '登山', content: '攜帶飲水', section: '活動' }]),
    }, faulty);
    expect(response.status).toBe(200);
    const request = await asOwner(`/api/requests/${requestId}`);
    expect(await request.json()).toMatchObject({ status: 'completed' });
    expect((await readTrip(getAiState)).jobs).toContainEqual(expect.objectContaining({
      docType: 'tips', requestId, status: 'completed',
    }));
    expect((await readTrip(getNotes)).pretripNotes).toContainEqual(expect.objectContaining({ title: '登山', content: '攜帶飲水' }));
  });

  describe('docType=lodging-tips', () => {
    it('完成 → INSERT trip_pretrip_notes ai_source=lodging-tips', async () => {
      const { requestId, jobId } = await createJobAndRequest('lodging-tips');
      const reply = JSON.stringify([
        { title: '飯店早餐', content: '7:00-10:00', section: '住宿在地' },
        { title: '附近便利店', content: '步行 3 分', section: '住宿在地' },
      ]);
      const res = await callPatch(requestId, { status: 'completed', reply });
      expect(res.status).toBe(200);
      const job = await db.prepare('SELECT status, inserted_count FROM trip_note_ai_jobs WHERE id = ?').bind(jobId).first<{ status: string; inserted_count: number }>();
      expect(job!.status).toBe('completed');
      expect(job!.inserted_count).toBe(2);
      const rows = await db.prepare(`SELECT title, ai_source, ai_generated FROM trip_pretrip_notes WHERE trip_id = ? AND ai_source = 'lodging-tips'`).bind(tripId).all<{ title: string; ai_source: string; ai_generated: number }>();
      expect(rows.results!.length).toBe(2);
      expect(rows.results!.every((r) => r.ai_generated === 1)).toBe(true);
    });
  });

  describe('docType=tips', () => {
    it('完成 → INSERT trip_pretrip_notes ai_source=general-tips (區分 lodging-tips)', async () => {
      const { requestId } = await createJobAndRequest('tips');
      const reply = JSON.stringify([
        { title: '貨幣', content: 'TWD ≈ 4.8 JPY', section: '貨幣' },
        { title: '插頭', content: 'A 型 110V', section: '電子設備' },
      ]);
      await callPatch(requestId, { status: 'completed', reply });
      const rows = await db.prepare(`SELECT title, ai_source FROM trip_pretrip_notes WHERE trip_id = ? AND ai_source = 'general-tips'`).bind(tripId).all<{ title: string; ai_source: string }>();
      expect(rows.results!.length).toBeGreaterThanOrEqual(2);
      // 確認區分：lodging-tips 仍存在
      const all = await db.prepare(`SELECT COUNT(*) AS n FROM trip_pretrip_notes WHERE trip_id = ?`).bind(tripId).first<{ n: number }>();
      expect(all!.n).toBeGreaterThanOrEqual(4); // 2 lodging-tips + 2 tips
    });
  });

  describe('docType=emergency', () => {
    it('完成 → INSERT schema 合法的 trip_emergency_contacts', async () => {
      const { requestId, jobId } = await createJobAndRequest('emergency');
      const reply = JSON.stringify([
        { name: '日本警察', phone: '110', kind: 'police', relationship: '報案' },
        { name: '駐那霸經文辦', phone: '+81988628603', kind: 'embassy' },
      ]);
      await callPatch(requestId, { status: 'completed', reply });
      const job = await db.prepare('SELECT status, inserted_count FROM trip_note_ai_jobs WHERE id = ?').bind(jobId).first<{ status: string; inserted_count: number }>();
      expect(job!.status).toBe('completed');
      expect(job!.inserted_count).toBe(2);
    });
  });

  describe('dedup', () => {
    it('人工維護的 semantic duplicate → 保留人工且不重複 INSERT', async () => {
      await db.prepare(
        `INSERT INTO trip_pretrip_notes (trip_id, section, title, content)
         VALUES (?, '一般', '人工固定', '不可覆蓋')`,
      ).bind(tripId).run();
      const { requestId, jobId } = await createJobAndRequest('tips');
      const reply = JSON.stringify([
        { title: '人工固定', content: 'duplicate', section: '一般' },
        { title: '新項目 unique', content: 'fresh', section: 'X' },
      ]);
      await callPatch(requestId, { status: 'completed', reply });
      const job = await db.prepare('SELECT inserted_count FROM trip_note_ai_jobs WHERE id = ?').bind(jobId).first<{ inserted_count: number }>();
      expect(job!.inserted_count).toBe(1);
      const manual = await db.prepare(
        `SELECT content, managed_by FROM trip_pretrip_notes
         WHERE trip_id = ? AND title = '人工固定'`,
      ).bind(tripId).first<{ content: string; managed_by: string }>();
      expect(manual).toEqual({ content: '不可覆蓋', managed_by: 'human' });
    });
  });

  describe('failed status', () => {
    it('PATCH failed → UPDATE trip_note_ai_jobs.status=failed + error_message', async () => {
      const { requestId, jobId } = await createJobAndRequest('emergency');
      await callPatch(requestId, { status: 'failed', reply: 'AI service timeout' });
      const job = await db.prepare('SELECT status, error_message FROM trip_note_ai_jobs WHERE id = ?').bind(jobId).first<{ status: string; error_message: string | null }>();
      expect(job!.status).toBe('failed');
      expect(job!.error_message).toContain('timeout');
    });
  });

  describe('no linkage row', () => {
    it('PATCH without trip_note_ai_jobs linkage → no side effect (chat reply still works)', async () => {
      const req = await db
        .prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING id')
        .bind(tripId, 'plain chat message', ownerEmail)
        .first<{ id: number }>();
      const res = await callPatch(req!.id, { status: 'completed', reply: 'just a reply' });
      expect(res.status).toBe(200);
      // No trip_note_ai_jobs row created since none linked
      const job = await db.prepare('SELECT id FROM trip_note_ai_jobs WHERE request_id = ?').bind(req!.id).first();
      expect(job).toBeNull();
    });
  });

  describe('reply rewritten', () => {
    it('完成後 trip_requests.reply 改成 user-friendly summary', async () => {
      const { requestId } = await createJobAndRequest('emergency');
      const reply = JSON.stringify([{ name: '新警察', phone: '999', kind: 'police' }]);
      await callPatch(requestId, { status: 'completed', reply });
      const row = await db.prepare('SELECT reply FROM trip_requests WHERE id = ?').bind(requestId).first<{ reply: string }>();
      expect(row!.reply).toContain('AI 生成完成');
      expect(row!.reply).toContain('[前往行程筆記');
      expect(row!.reply).not.toContain('"phone"'); // raw JSON not surfaced
    });
  });

  // PR27 — AI-driven INSERT 補 audit_log
  describe('PR27 audit_log on AI insert', () => {
    async function fetchAudit(tableName: string, requestId: number) {
      const rs = await db
        .prepare(
          `SELECT action, changed_by AS changedBy, request_id AS requestId, diff_json AS diffJson, record_id AS recordId
           FROM audit_log WHERE trip_id = ? AND table_name = ? AND request_id = ? ORDER BY id ASC`,
        )
        .bind(tripId, tableName, requestId)
        .all<{ action: string; changedBy: string; requestId: number; diffJson: string; recordId: number }>();
      return rs.results ?? [];
    }

    it('lodging-tips AI insert → audit_log action=insert + changedBy=ai:<submitted_by>', async () => {
      const { requestId } = await createJobAndRequest('lodging-tips');
      const reply = JSON.stringify([{ title: 'AI lodging tip', content: 'foo', section: '住宿在地' }]);
      await callPatch(requestId, { status: 'completed', reply });

      const rows = await fetchAudit('trip_pretrip_notes', requestId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.action).toBe('insert');
      expect(rows[0]!.changedBy).toBe(`ai:${ownerEmail}`);
      expect(rows[0]!.requestId).toBe(requestId);
      expect(rows[0]!.diffJson).toContain('AI lodging tip');
      expect(rows[0]!.recordId).toBeGreaterThan(0);
    });

    it('emergency AI insert → audit_log per row', async () => {
      const { requestId } = await createJobAndRequest('emergency');
      const reply = JSON.stringify([
        { name: 'PR27 警察局', phone: '110', kind: 'police' },
        { name: 'PR27 醫院', phone: '119', kind: 'medical' },
      ]);
      await callPatch(requestId, { status: 'completed', reply });

      const rows = await fetchAudit('trip_emergency_contacts', requestId);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.action === 'insert')).toBe(true);
      expect(rows.every((r) => r.changedBy === `ai:${ownerEmail}`)).toBe(true);
      const joined = rows.map((r) => r.diffJson).join('|');
      expect(joined).toContain('PR27 警察局');
      expect(joined).toContain('PR27 醫院');
    });

    it('submitted_by NULL → changedBy=system:ai fallback', async () => {
      const req = await db
        .prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, NULL) RETURNING id')
        .bind(tripId, '[行程筆記-tips] sysai test')
        .first<{ id: number }>();
      await db
        .prepare('INSERT INTO trip_note_ai_jobs (request_id, trip_id, doc_type) VALUES (?, ?, ?)')
        .bind(req!.id, tripId, 'tips')
        .run();
      const reply = JSON.stringify([{ title: 'sysai tip', content: 'x', section: '一般' }]);
      await callPatch(req!.id, { status: 'completed', reply });

      const rows = await fetchAudit('trip_pretrip_notes', req!.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.changedBy).toBe('system:ai');
    });

    it('failed status → 不寫 audit_log（沒 INSERT 就沒記錄）', async () => {
      const { requestId } = await createJobAndRequest('lodging-tips');
      await callPatch(requestId, { status: 'failed', reply: 'Claude timeout' });

      const rows = await fetchAudit('trip_pretrip_notes', requestId);
      expect(rows.length).toBe(0);
    });
  });

  // 補強：PATCH /requests/:id 的授權（companion service token 或對該 trip 有寫權的使用者）
  describe('授權', () => {
    it('非成員的使用者與僅有維運 scope 的 token 都不能回報完成，job 與筆記不變', async () => {
      const authTrip = `${PREFIX}-auth-1`;
      await seedTrip(db, { id: authTrip, owner: ownerEmail });
      const { requestId, jobId } = await createJobAndRequest('tips', authTrip);
      const body = { status: 'completed', reply: JSON.stringify([{ title: '入侵項目', content: 'x', section: '一般' }]) };
      const strangerEmail = `${PREFIX}-stranger@hook.test`;
      await seedUser(db, strangerEmail);
      const asStranger = await api.request('PATCH', `/api/requests/${requestId}`, { as: strangerEmail, json: body });
      expect(asStranger.status).toBe(403);
      const opsOnly = await serviceTokenFor(db, { clientId: 's14-ops', scopes: ['ops:maps'] });
      const asOps = await api.request('PATCH', `/api/requests/${requestId}`, { bearer: opsOnly, json: body });
      expect(asOps.status).toBe(403);

      expect(await db.prepare('SELECT status FROM trip_note_ai_jobs WHERE id = ?').bind(jobId).first()).toEqual({ status: 'pending' });
      expect(await db.prepare('SELECT status FROM trip_requests WHERE id = ?').bind(requestId).first()).not.toEqual({ status: 'completed' });
      expect(await db.prepare("SELECT COUNT(*) AS n FROM trip_pretrip_notes WHERE trip_id = ? AND title = '入侵項目'").bind(authTrip).first()).toEqual({ n: 0 });
    });

    it('未帶 token 回 401', async () => {
      const authTrip = `${PREFIX}-auth-2`;
      await seedTrip(db, { id: authTrip, owner: ownerEmail });
      const { requestId } = await createJobAndRequest('tips', authTrip);
      expect((await api.request('PATCH', `/api/requests/${requestId}`, {
        headers: { Origin: 'https://trip-planner-dby.pages.dev' }, // 通過 CSRF Origin 檢查，才輪到認證
        json: { status: 'failed' },
      })).status).toBe(401);
    });
  });
});
