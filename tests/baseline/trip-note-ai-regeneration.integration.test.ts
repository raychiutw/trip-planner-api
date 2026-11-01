/**
 * 行程筆記 AI 重新生成：走 HTTP 邊界（PATCH /api/requests/:id 的完成 hook、筆記維護／排除／AI state）。
 * 認證一律經 middleware 的真實 bearer token（companion service token／行程 owner）。
 * 共用 D1：行程、email、request 都用 `s14-ai` 專屬前綴，afterAll 清掉自己的資料。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { createApi, type Api } from './http';
import { mockEnv, seedTrip, seedUser } from './helpers';
import { cleanupNotes } from './cleanup-notes';
import { serviceTokenFor } from './service-token';
import { createTestDb, disposeMiniflare } from './setup';

const PREFIX = 's14-ai';
let db: D1Database;
let env: Env;
let api: Api;
let serviceToken: string;
const ownerEmail = `${PREFIX}-owner@note-ai.test`;
let sequence = 0;

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  await seedUser(db, ownerEmail);
  serviceToken = await serviceTokenFor(db, { clientId: 's14-cli', scopes: ['companion'] });
}, 90000);

afterAll(async () => {
  await cleanupNotes(db, PREFIX);
  await disposeMiniflare();
});

async function freshTrip() {
  const tripId = `${PREFIX}-trip-${++sequence}`;
  await seedTrip(db, { id: tripId, owner: ownerEmail });
  return tripId;
}

async function createJob(tripId: string, docType: 'lodging-tips' | 'tips' | 'emergency') {
  const request = await db
    .prepare('INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING id')
    .bind(tripId, `[行程筆記-${docType}] test`, ownerEmail)
    .first<{ id: number }>();
  const job = await db
    .prepare(
      `INSERT INTO trip_note_ai_jobs
         (request_id, trip_id, doc_type, generation, timeout_at)
       VALUES (?, ?, ?, 1, datetime('now', '+10 minutes'))
       RETURNING id`,
    )
    .bind(request!.id, tripId, docType)
    .first<{ id: number }>();
  return { requestId: request!.id, jobId: job!.id };
}

/** 以 companion service token 回報 request 完成（Claude CLI 的身分）。`target` 可換成注入了競態的 api。 */
function complete(requestId: number, reply: string, target: Api = api) {
  return target.request('PATCH', `/api/requests/${requestId}`, {
    bearer: serviceToken,
    json: { status: 'completed', reply },
  });
}

/** 注入競態：第一次 `batch` 之前先執行 `race`，模擬套用前同時發生的人工維護。 */
function apiWithBatchRace(race: () => Promise<void>): Api {
  let injected = false;
  const raceDb = new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!injected) {
            injected = true;
            await race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
  return createApi({ env: { ...env, DB: raceDb } });
}

/** 以行程 owner 的身分呼叫。`target` 換成注入競態的 api 時，token 必須先由正常的 api 簽出。 */
async function owner(method: string, path: string, json?: unknown, target: Api = api) {
  return target.request(method, path, { bearer: await api.tokenFor(ownerEmail), json });
}

describe('AI 重新生成套用', () => {
  it('原子替換同 docType 的 AI 維護項目，保留人工項目並寫摘要', async () => {
    const tripId = await freshTrip();
    await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, sort_order, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, 0, '人工提醒', '保留', 0, NULL, 'human', 'human', 'manual'),
              (?, 1, '舊貨幣', '應替換', 1, 'general-tips', 'ai', 'ai', 'tips:currency')`,
    ).bind(tripId, tripId).run();
    const { requestId, jobId } = await createJob(tripId, 'tips');

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: '準備現金與信用卡。', section: '貨幣' },
      { title: '插座規格', content: '確認電壓與轉接頭。', section: '插座' },
    ]));

    const rows = await db.prepare(
      `SELECT title, origin, managed_by FROM trip_pretrip_notes
       WHERE trip_id = ? ORDER BY sort_order`,
    ).bind(tripId).all<{ title: string; origin: string; managed_by: string }>();
    expect(rows.results).toEqual([
      expect.objectContaining({ title: '人工提醒', managed_by: 'human' }),
      expect.objectContaining({ title: '當地貨幣', origin: 'ai', managed_by: 'ai' }),
      expect.objectContaining({ title: '插座規格', origin: 'ai', managed_by: 'ai' }),
    ]);
    const job = await db.prepare(
      `SELECT status, inserted_count, replaced_count, preserved_manual_count
       FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(jobId).first<{
      status: string;
      inserted_count: number;
      replaced_count: number;
      preserved_manual_count: number;
    }>();
    expect(job).toMatchObject({
      status: 'completed',
      inserted_count: 2,
      replaced_count: 1,
      preserved_manual_count: 1,
    });
  });

  it('舊 AI 項目若曾人工編輯，即使 semantic_key 尚未回填也不會重複生成同主題', async () => {
    const tripId = await freshTrip();
    await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, '貨幣與付款', '人工確認過的內容', 1, 'general-tips', 'ai', 'human', NULL)`,
    ).bind(tripId).run();
    const { requestId, jobId } = await createJob(tripId, 'tips');

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: 'AI 新內容', section: '貨幣' },
      { title: '插座規格', content: '確認電壓與轉接頭。', section: '插座' },
    ]));

    const rows = await db.prepare(
      `SELECT title, managed_by FROM trip_pretrip_notes
       WHERE trip_id = ? ORDER BY sort_order, id`,
    ).bind(tripId).all<{ title: string; managed_by: string }>();
    expect(rows.results).toEqual([
      { title: '貨幣與付款', managed_by: 'human' },
      { title: '插座規格', managed_by: 'ai' },
    ]);
    const job = await db.prepare(
      `SELECT preserved_manual_count, suppressed_count
       FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(jobId).first<{ preserved_manual_count: number; suppressed_count: number }>();
    expect(job).toEqual({ preserved_manual_count: 1, suppressed_count: 1 });
  });

  it('全部新項目都被人工內容排除時，仍會清除同類型舊 AI 項目', async () => {
    const tripId = await freshTrip();
    await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, sort_order, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, 0, '貨幣與付款', '人工內容', 1, 'general-tips', 'ai', 'human', 'tips:currency'),
              (?, 1, '舊插座提醒', '舊 AI 內容', 1, 'general-tips', 'ai', 'ai', 'tips:electricity')`,
    ).bind(tripId, tripId).run();
    const { requestId, jobId } = await createJob(tripId, 'tips');

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: 'AI 新內容', section: '貨幣' },
    ]));

    const rows = await db.prepare(
      `SELECT title, managed_by FROM trip_pretrip_notes WHERE trip_id = ?`,
    ).bind(tripId).all<{ title: string; managed_by: string }>();
    expect(rows.results).toEqual([{ title: '貨幣與付款', managed_by: 'human' }]);
    expect(await db.prepare(
      `SELECT inserted_count, replaced_count, preserved_manual_count, suppressed_count
       FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(jobId).first()).toEqual({
      inserted_count: 0,
      replaced_count: 1,
      preserved_manual_count: 1,
      suppressed_count: 1,
    });
  });

  it('套用前同時發生人工維護與排除時，batch guard 不覆蓋也不讓項目重新出現', async () => {
    const tripId = await freshTrip();
    const row = await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, '舊貨幣', '正在人工編輯', 1, 'general-tips', 'ai', 'ai', 'tips:currency')
       RETURNING id`,
    ).bind(tripId).first<{ id: number }>();
    const { requestId, jobId } = await createJob(tripId, 'tips');
    const raced = apiWithBatchRace(async () => {
      await db.prepare(
        `UPDATE trip_pretrip_notes SET managed_by = 'human' WHERE id = ?`,
      ).bind(row!.id).run();
      await db.prepare(
        `INSERT INTO trip_note_ai_exclusions
           (trip_id, doc_type, semantic_key, label)
         VALUES (?, 'tips', 'tips:electricity', '插座')`,
      ).bind(tripId).run();
    });

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: 'AI 新內容', section: '貨幣' },
      { title: '插座規格', content: 'AI 新內容', section: '插座' },
    ]), raced);

    const rows = await db.prepare(
      `SELECT title, managed_by FROM trip_pretrip_notes WHERE trip_id = ?`,
    ).bind(tripId).all<{ title: string; managed_by: string }>();
    expect(rows.results).toEqual([{ title: '舊貨幣', managed_by: 'human' }]);
    const job = await db.prepare(
      `SELECT inserted_count, replaced_count, preserved_manual_count,
              duplicate_excluded_count, suppressed_count
       FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(jobId).first<Record<string, number>>();
    expect(job).toEqual({
      inserted_count: 0,
      replaced_count: 0,
      preserved_manual_count: 1,
      duplicate_excluded_count: 1,
      suppressed_count: 1,
    });
  });

  it('套用前人工項目交還 AI 時不會被 stale manual snapshot 刪除', async () => {
    const tripId = await freshTrip();
    const row = await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, '貨幣與付款', '人工確認過', 1, 'general-tips', 'ai', 'human', 'tips:currency')
       RETURNING id`,
    ).bind(tripId).first<{ id: number }>();
    const { requestId } = await createJob(tripId, 'tips');
    const raced = apiWithBatchRace(async () => {
      await db.prepare(
        `UPDATE trip_pretrip_notes SET managed_by = 'ai' WHERE id = ?`,
      ).bind(row!.id).run();
    });

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: 'AI 新內容', section: '貨幣' },
    ]), raced);

    expect(await db.prepare(
      `SELECT title, managed_by FROM trip_pretrip_notes WHERE id = ?`,
    ).bind(row!.id).first()).toEqual({ title: '貨幣與付款', managed_by: 'ai' });
  });

  it('套用前新增人工同主題時，batch guard 不會再插入 AI 重複項目', async () => {
    const tripId = await freshTrip();
    const { requestId, jobId } = await createJob(tripId, 'tips');
    const raced = apiWithBatchRace(async () => {
      await db.prepare(
        `INSERT INTO trip_pretrip_notes
           (trip_id, title, content, origin, managed_by, semantic_key)
         VALUES (?, '人工貨幣提醒', '人工內容', 'human', 'human', 'currency')`,
      ).bind(tripId).run();
    });

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: 'AI 新內容', section: '貨幣' },
    ]), raced);

    const rows = await db.prepare(
      `SELECT title, origin FROM trip_pretrip_notes WHERE trip_id = ?`,
    ).bind(tripId).all<{ title: string; origin: string }>();
    expect(rows.results).toEqual([{ title: '人工貨幣提醒', origin: 'human' }]);
    expect(await db.prepare(
      `SELECT inserted_count, suppressed_count FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(jobId).first()).toEqual({ inserted_count: 0, suppressed_count: 1 });
  });

  it.each(['not json', '[]'])('invalid/empty output「%s」會失敗且不碰既有 AI 內容', async (reply) => {
    const tripId = await freshTrip();
    await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, '舊資料', '必須保留', 1, 'general-tips', 'ai', 'ai', 'tips:old')`,
    ).bind(tripId).run();
    const { requestId, jobId } = await createJob(tripId, 'tips');

    await complete(requestId, reply);

    const job = await db.prepare(
      'SELECT status, error_code FROM trip_note_ai_jobs WHERE id = ?',
    ).bind(jobId).first<{ status: string; error_code: string }>();
    expect(job).toEqual({
      status: 'failed',
      error_code: reply === '[]' ? 'NOTES_AI_NO_VALID_ITEMS' : 'NOTES_AI_INVALID_OUTPUT',
    });
    const old = await db.prepare(
      `SELECT content FROM trip_pretrip_notes WHERE trip_id = ? AND title = '舊資料'`,
    ).bind(tripId).first<{ content: string }>();
    expect(old?.content).toBe('必須保留');
  });

  it('同一份回覆內同主題重複的項目只留第一筆，其餘計入略過', async () => {
    const tripId = await freshTrip();
    const { requestId, jobId } = await createJob(tripId, 'tips');

    await complete(requestId, JSON.stringify([
      { title: '當地貨幣', content: '第一筆內容', section: '貨幣' },
      { title: '當地貨幣', content: '重複的第二筆', section: '貨幣' },
    ]));

    const rows = await db.prepare(
      'SELECT title, content FROM trip_pretrip_notes WHERE trip_id = ?',
    ).bind(tripId).all();
    expect(rows.results).toEqual([{ title: '當地貨幣', content: '第一筆內容' }]);
    expect(await db.prepare(
      'SELECT inserted_count, suppressed_count FROM trip_note_ai_jobs WHERE id = ?',
    ).bind(jobId).first()).toEqual({ inserted_count: 1, suppressed_count: 1 });
  });

  it('emergency：人工維護的聯絡人不會被重新生成刪掉，AI 維護的舊聯絡人會被替換', async () => {
    const tripId = await freshTrip();
    await db.prepare(
      `INSERT INTO trip_emergency_contacts
         (trip_id, sort_order, name, phone, kind, ai_generated, origin, managed_by, semantic_key)
       VALUES (?, 0, '人工確認警察', '110', 'police', 1, 'ai', 'human', NULL),
              (?, 1, '舊醫院', '119', 'medical', 1, 'ai', 'ai', 'emergency:medical')`,
    ).bind(tripId, tripId).run();
    const { requestId } = await createJob(tripId, 'emergency');

    await complete(requestId, JSON.stringify([
      { name: '新大使館', phone: '+81000', kind: 'embassy', relationship: '協助' },
    ]));

    const rows = await db.prepare(
      'SELECT name, managed_by FROM trip_emergency_contacts WHERE trip_id = ? ORDER BY name',
    ).bind(tripId).all();
    expect(rows.results).toEqual(expect.arrayContaining([
      { name: '人工確認警察', managed_by: 'human' },
      { name: '新大使館', managed_by: 'ai' },
    ]));
    expect(rows.results).toHaveLength(2);
  });

  it('timed_out job 的遲到 callback 不可套用內容', async () => {
    const tripId = await freshTrip();
    const { requestId, jobId } = await createJob(tripId, 'emergency');
    await db.prepare(
      `UPDATE trip_note_ai_jobs
       SET status = 'timed_out', error_code = 'NOTES_AI_JOB_STALE', completed_at = datetime('now')
       WHERE id = ?`,
    ).bind(jobId).run();

    await complete(requestId, JSON.stringify([
      { name: '遲到的警察', phone: '110', kind: 'police', relationship: '報案' },
    ]));

    const count = await db.prepare(
      `SELECT COUNT(*) AS n FROM trip_emergency_contacts WHERE trip_id = ?`,
    ).bind(tripId).first<{ n: number }>();
    expect(count?.n).toBe(0);
    const job = await db.prepare(
      'SELECT status FROM trip_note_ai_jobs WHERE id = ?',
    ).bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe('timed_out');
  });
});

describe('人工維護、排除與恢復', () => {
  it('人工新增與編輯會維護主題鍵，供生成中的 DB guard 去重', async () => {
    const tripId = await freshTrip();
    const created = await owner('POST', `/api/trips/${tripId}/notes/pretrip`, {
      title: '貨幣與付款',
      content: '人工內容',
    });
    expect(await created.json()).toMatchObject({
      origin: 'human',
      semanticKey: 'currency',
      version: 0,
    });

    const row = await db.prepare(
      `SELECT id FROM trip_pretrip_notes WHERE trip_id = ?`,
    ).bind(tripId).first<{ id: number }>();
    const edited = await owner('PATCH', `/api/trips/${tripId}/notes/pretrip/${row!.id}`, {
      title: '插座規格',
      expectedVersion: 0,
    });
    expect(await edited.json()).toMatchObject({
      origin: 'human',
      semanticKey: 'electricity',
      version: 1,
    });
  });

  it('編輯 AI 項目轉成人工維護；可交還 AI，純人工項目不可交還', async () => {
    const tripId = await freshTrip();
    const aiRow = await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, 'AI 提醒', '原內容', 1, 'general-tips', 'ai', 'ai', NULL)
       RETURNING id, version`,
    ).bind(tripId).first<{ id: number; version: number }>();
    const humanRow = await db.prepare(
      `INSERT INTO trip_pretrip_notes (trip_id, title, content)
       VALUES (?, '人工提醒', '內容') RETURNING id, version`,
    ).bind(tripId).first<{ id: number; version: number }>();

    const markedHuman = await owner('PATCH', `/api/trips/${tripId}/notes/pretrip/${aiRow!.id}/maintenance`, {
      managedBy: 'human',
      expectedVersion: aiRow!.version,
    });
    expect(await markedHuman.json()).toMatchObject({
      origin: 'ai',
      managedBy: 'human',
      semanticKey: 'tips:ai提醒',
    });

    const edited = await owner('PATCH', `/api/trips/${tripId}/notes/pretrip/${aiRow!.id}`, {
      title: '插座規格',
      expectedVersion: 1,
    });
    expect(await edited.json()).toMatchObject({
      origin: 'ai',
      managedBy: 'human',
      semanticKey: 'tips:electricity',
    });

    const returned = await owner('PATCH', `/api/trips/${tripId}/notes/pretrip/${aiRow!.id}/maintenance`, {
      managedBy: 'ai',
      expectedVersion: 2,
    });
    expect(returned.status).toBe(200);
    expect(await returned.json()).toMatchObject({ origin: 'ai', managedBy: 'ai' });

    const rejected = await owner('PATCH', `/api/trips/${tripId}/notes/pretrip/${humanRow!.id}/maintenance`, {
      managedBy: 'ai',
      expectedVersion: humanRow!.version,
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as any).error.code).toBe('NOTES_AI_NOT_REASSIGNABLE');
  });

  it('刪除 AI 維護項目建立 tombstone；可列出並單筆恢復', async () => {
    const tripId = await freshTrip();
    const row = await db.prepare(
      `INSERT INTO trip_emergency_contacts
         (trip_id, name, phone, kind, ai_generated, origin, managed_by, semantic_key)
       VALUES (?, '日本警察', '110', 'police', 1, 'ai', 'ai', 'emergency:police')
       RETURNING id`,
    ).bind(tripId).first<{ id: number }>();
    const deleted = await owner('DELETE', `/api/trips/${tripId}/notes/emergency/${row!.id}`);
    expect(await deleted.json()).toMatchObject({ ok: true, excluded: true });

    const listed = await owner('GET', `/api/trips/${tripId}/notes/emergency/exclusions`);
    const listBody = await listed.json() as any;
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({
      semanticKey: 'emergency:police',
      label: '日本警察',
    });

    const excludedJob = await createJob(tripId, 'emergency');
    await complete(excludedJob.requestId, JSON.stringify([
      { name: '日本警察', phone: '110', kind: 'police', relationship: '報案' },
    ]));
    const excludedSummary = await db.prepare(
      `SELECT status, inserted_count, duplicate_excluded_count
       FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(excludedJob.jobId).first<{
      status: string;
      inserted_count: number;
      duplicate_excluded_count: number;
    }>();
    expect(excludedSummary).toEqual({
      status: 'completed',
      inserted_count: 0,
      duplicate_excluded_count: 1,
    });

    const restored = await owner('DELETE', `/api/trips/${tripId}/notes/emergency/exclusions/${listBody.items[0].id}`);
    expect(restored.status).toBe(200);
    const remaining = await db.prepare(
      'SELECT COUNT(*) AS n FROM trip_note_ai_exclusions WHERE trip_id = ?',
    ).bind(tripId).first<{ n: number }>();
    expect(remaining?.n).toBe(0);

    const restoredJob = await createJob(tripId, 'emergency');
    await complete(restoredJob.requestId, JSON.stringify([
      { name: '日本警察', phone: '110', kind: 'police', relationship: '報案' },
    ]));
    const regenerated = await db.prepare(
      `SELECT name, managed_by FROM trip_emergency_contacts
       WHERE trip_id = ? AND semantic_key = 'emergency:police'`,
    ).bind(tripId).first<{ name: string; managed_by: string }>();
    expect(regenerated).toEqual({ name: '日本警察', managed_by: 'ai' });
  });

  it('生成剛替換完成時刪除舊 ID，仍會刪掉同主題的新 AI row', async () => {
    const tripId = await freshTrip();
    const old = await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, '貨幣與付款', '舊內容', 1, 'general-tips', 'ai', 'ai', 'tips:currency')
       RETURNING id`,
    ).bind(tripId).first<{ id: number }>();
    await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, '人工維護貨幣', '不可刪除', 1, 'general-tips', 'ai', 'human', 'tips:currency')`,
    ).bind(tripId).run();
    const raced = apiWithBatchRace(async () => {
      await db.prepare('DELETE FROM trip_pretrip_notes WHERE id = ?').bind(old!.id).run();
      await db.prepare(
        `INSERT INTO trip_pretrip_notes
           (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
         VALUES (?, '當地貨幣', '新內容', 1, 'general-tips', 'ai', 'ai', 'tips:currency')`,
      ).bind(tripId).run();
    });

    const deleted = await owner('DELETE', `/api/trips/${tripId}/notes/pretrip/${old!.id}`, undefined, raced);

    expect(await deleted.json()).toMatchObject({ ok: true, excluded: true });
    expect(await db.prepare(
      `SELECT title, managed_by FROM trip_pretrip_notes WHERE trip_id = ?`,
    ).bind(tripId).all()).toMatchObject({
      results: [{ title: '人工維護貨幣', managed_by: 'human' }],
    });
  });
});

describe('GET AI state', () => {
  it('回傳三種 docType、摘要、排除數，並將逾時 active job 標成 timedOut', async () => {
    const tripId = await freshTrip();
    const { jobId, requestId } = await createJob(tripId, 'tips');
    await db.prepare(
      `UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-1 second') WHERE id = ?`,
    ).bind(jobId).run();
    await db.prepare(
      `INSERT INTO trip_note_ai_exclusions (trip_id, doc_type, semantic_key, label)
       VALUES (?, 'tips', 'tips:currency', '貨幣')`,
    ).bind(tripId).run();

    const response = await owner('GET', `/api/trips/${tripId}/notes/ai-state`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.jobs).toHaveLength(3);
    expect(body.jobs.find((job: any) => job.docType === 'tips')).toMatchObject({
      status: 'timedOut',
      exclusionCount: 1,
      errorCode: 'NOTES_AI_JOB_STALE',
    });
    expect(await db.prepare(
      'SELECT status FROM trip_requests WHERE id = ?',
    ).bind(requestId).first()).toMatchObject({ status: 'failed' });
  });
});

describe('權限與版本檢查（補強既有行為的守門）', () => {
  const strangerEmail = `${PREFIX}-stranger@note-ai.test`;

  it('非行程成員不能讀 AI state／排除清單，也不能維護、新增或刪除筆記', async () => {
    const tripId = await freshTrip();
    await seedUser(db, strangerEmail);
    const aiRow = await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, 'AI 提醒', '原內容', 1, 'general-tips', 'ai', 'ai', 'tips:x') RETURNING id, version`,
    ).bind(tripId).first<{ id: number; version: number }>();
    const contact = await db.prepare(
      `INSERT INTO trip_emergency_contacts
         (trip_id, name, phone, kind, ai_generated, origin, managed_by, semantic_key)
       VALUES (?, '日本警察', '110', 'police', 1, 'ai', 'ai', 'emergency:police') RETURNING id`,
    ).bind(tripId).first<{ id: number }>();
    const stranger = (method: string, path: string, json?: unknown) =>
      api.request(method, path, { as: strangerEmail, json });

    expect((await stranger('GET', `/api/trips/${tripId}/notes/ai-state`)).status).toBe(403);
    expect((await stranger('GET', `/api/trips/${tripId}/notes/emergency/exclusions`)).status).toBe(403);
    expect((await stranger('PATCH', `/api/trips/${tripId}/notes/pretrip/${aiRow!.id}/maintenance`, {
      managedBy: 'human', expectedVersion: aiRow!.version,
    })).status).toBe(403);
    expect((await stranger('POST', `/api/trips/${tripId}/notes/pretrip`, { title: '入侵', content: 'x' })).status).toBe(403);
    expect((await stranger('DELETE', `/api/trips/${tripId}/notes/emergency/${contact!.id}`)).status).toBe(403);
    const exclusion = await db.prepare(
      `INSERT INTO trip_note_ai_exclusions (trip_id, doc_type, semantic_key, label)
       VALUES (?, 'emergency', 'emergency:police', '日本警察') RETURNING id`,
    ).bind(tripId).first<{ id: number }>();
    expect((await stranger('DELETE', `/api/trips/${tripId}/notes/emergency/exclusions/${exclusion!.id}`)).status).toBe(403);

    // 被擋下的請求不得改動資料
    expect(await db.prepare('SELECT managed_by, version FROM trip_pretrip_notes WHERE id = ?').bind(aiRow!.id).first())
      .toEqual({ managed_by: 'ai', version: aiRow!.version });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM trip_pretrip_notes WHERE trip_id = ?').bind(tripId).first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM trip_emergency_contacts WHERE trip_id = ?').bind(tripId).first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM trip_note_ai_exclusions WHERE trip_id = ?').bind(tripId).first<{ n: number }>())!.n).toBe(1);
  });

  it('未帶 token 讀 AI state 回 401', async () => {
    const tripId = await freshTrip();
    expect((await api.get(`/api/trips/${tripId}/notes/ai-state`)).status).toBe(401);
  });

  it('維護歸屬帶過期的 expectedVersion 回 409 STALE_ENTRY，且不改動資料', async () => {
    const tripId = await freshTrip();
    const aiRow = await db.prepare(
      `INSERT INTO trip_pretrip_notes
         (trip_id, title, content, ai_generated, ai_source, origin, managed_by, semantic_key)
       VALUES (?, 'AI 提醒', '原內容', 1, 'general-tips', 'ai', 'ai', 'tips:x') RETURNING id, version`,
    ).bind(tripId).first<{ id: number; version: number }>();

    const stale = await owner('PATCH', `/api/trips/${tripId}/notes/pretrip/${aiRow!.id}/maintenance`, {
      managedBy: 'human', expectedVersion: aiRow!.version + 5,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error.code).toBe('STALE_ENTRY');
    expect(await db.prepare('SELECT managed_by, version FROM trip_pretrip_notes WHERE id = ?').bind(aiRow!.id).first())
      .toEqual({ managed_by: 'ai', version: aiRow!.version });
  });
});
