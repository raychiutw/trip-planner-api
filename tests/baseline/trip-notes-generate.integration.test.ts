/**
 * Integration tests — POST /api/trips/:id/notes/:type/generate (v2.34.x 行程筆記 PR9)
 *
 * Covers:
 *   - 3 valid types create job + request linkage
 *   - Invalid type → 400
 *   - PERM_DENIED for non-authorized user
 *   - Debounce — 30s 內同 trip+type pending → return existing job (no double request)
 *   - trip_requests.message 含對應 prefix [行程筆記-{type}]
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTripNotes } from './cleanup-trip-notes';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const tripA = 's13-notes-gen-a';
const tripB = 's13-notes-gen-b';
const tripC = 's13-notes-gen-c';
const ownerEmail = 'owner@s13-notes-gen.test';
const strangerEmail = 'stranger@s13-notes-gen.test';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  await seedUser(db, ownerEmail);
  await seedUser(db, strangerEmail);
  await seedTrip(db, { id: tripA, owner: ownerEmail });
  await seedTrip(db, { id: tripB, owner: ownerEmail });
  await seedTrip(db, { id: tripC, owner: ownerEmail });
});

afterAll(async () => {
  await cleanupTripNotes(db, ['s13-notes-gen-%'], ['%@s13-notes-gen.test']);
  await disposeMiniflare();
});

function callGen(tripId: string, type: string, email = ownerEmail) {
  return api.request('POST', `/api/trips/${tripId}/notes/${type}/generate`, { as: email, json: {} });
}

describe('POST /api/trips/:id/notes/:type/generate', () => {
  for (const type of ['lodging-tips', 'tips', 'emergency']) {
    it(`type=${type} → 202 + jobId + requestId + status=pending`, async () => {
      const res = await callGen(tripA, type);
      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.tripId).toBe(tripA);
      expect(body.docType).toBe(type);
      expect(body.status).toBe('pending');
      expect(typeof body.jobId).toBe('number');
      expect(typeof body.requestId).toBe('number');
    });
  }

  it('invalid type → 400 DATA_VALIDATION', async () => {
    const res = await callGen(tripA, 'invalid-type');
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('PERM_DENIED 對非授權 user', async () => {
    const res = await callGen(tripA, 'tips', strangerEmail);
    expect(res.status).toBe(403);
  });

  it('trip_requests.message 含 [行程筆記-{type}] prefix', async () => {
    const res = await callGen(tripB, 'lodging-tips');
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    const row = await db
      .prepare('SELECT message FROM trip_requests WHERE id = ?')
      .bind(body.requestId)
      .first<{ message: string }>();
    expect(row!.message.startsWith('[行程筆記-lodging-tips]')).toBe(true);
  });

  it('trip_note_ai_jobs linkage row created with correct doc_type', async () => {
    const res = await callGen(tripB, 'emergency');
    const body = await res.json() as any;
    const row = await db
      .prepare('SELECT * FROM trip_note_ai_jobs WHERE id = ?')
      .bind(body.jobId)
      .first<{ request_id: number; trip_id: string; doc_type: string; status: string; inserted_count: number }>();
    expect(row!.request_id).toBe(body.requestId);
    expect(row!.trip_id).toBe(tripB);
    expect(row!.doc_type).toBe('emergency');
    expect(row!.status).toBe('pending');
    expect(row!.inserted_count).toBe(0);
  });

  it('debounce — 30s 內第二次同 trip+type 返回 existing job', async () => {
    const first = await callGen(tripB, 'tips');
    const firstBody = await first.json() as any;
    const second = await callGen(tripB, 'tips');
    expect(second.status).toBe(200); // 不是 202 — 已存在的 job
    const secondBody = await second.json() as any;
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(secondBody.requestId).toBe(firstBody.requestId);
  });

  it('active job 超過 30 秒仍返回同一 job；逾時後才建立下一代', async () => {
    const first = await callGen(tripC, 'tips');
    const firstBody = await first.json() as any;
    await db.prepare(
      `UPDATE trip_note_ai_jobs
       SET created_at = datetime('now', '-5 minutes'), timeout_at = datetime('now', '+5 minutes')
       WHERE id = ?`,
    ).bind(firstBody.jobId).run();

    const active = await callGen(tripC, 'tips');
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      jobId: firstBody.jobId,
      generation: 1,
    });

    await db.prepare(
      `UPDATE trip_note_ai_jobs SET timeout_at = datetime('now', '-1 second') WHERE id = ?`,
    ).bind(firstBody.jobId).run();
    const next = await callGen(tripC, 'tips');
    expect(next.status).toBe(202);
    expect(await next.json()).toMatchObject({ generation: 2, status: 'pending' });
    const expired = await db.prepare(
      `SELECT status, error_code FROM trip_note_ai_jobs WHERE id = ?`,
    ).bind(firstBody.jobId).first<{ status: string; error_code: string }>();
    expect(expired).toEqual({
      status: 'timed_out',
      error_code: 'NOTES_AI_JOB_STALE',
    });
  });
});

// 對外觸發（Mac Mini api-server）屬外部邊界：以 stub 取代全域 fetch，斷言送出內容與對回應的處理
describe('POST /api/trips/:id/notes/:type/generate — 對外觸發 api-server', () => {
  const tripT = 's13-notes-gen-trigger';
  const triggerEnv = () => mockEnv(db, { TRIPLINE_API_URL: 'https://api.example.test', TRIPLINE_API_SECRET: 'fake-secret' } as Partial<Env>);

  beforeAll(async () => {
    await seedTrip(db, { id: tripT, owner: ownerEmail });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function emailEvents(status: string) {
    const rs = await db.prepare(
      `SELECT diff_json AS diffJson FROM audit_log WHERE trip_id = ? AND table_name = 'email' ORDER BY id ASC`,
    ).bind(tripT).all<{ diffJson: string }>();
    return (rs.results ?? []).map((r) => JSON.parse(r.diffJson)).filter((d) => d.status === status);
  }

  it('成功 → POST {TRIPLINE_API_URL}/trigger?source=api，帶 Bearer secret 與 { requestId }', async () => {
    const stub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const res = await createApi({ env: triggerEnv() })
      .request('POST', `/api/trips/${tripT}/notes/tips/generate`, { as: ownerEmail, json: {} });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/trigger?source=api');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-secret');
    expect(JSON.parse(init.body as string)).toEqual({ requestId: body.requestId });
    expect(await emailEvents('trigger-failed')).toEqual([]);
  });

  it('api-server 回非 2xx → 仍回 202（不影響使用者），並記一筆 trigger-failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const res = await createApi({ env: triggerEnv() })
      .request('POST', `/api/trips/${tripT}/notes/emergency/generate`, { as: ownerEmail, json: {} });
    expect(res.status).toBe(202);
    const failed = await emailEvents('trigger-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('Trigger responded 500');
  });

  it('未設定 TRIPLINE_API_URL → 不對外呼叫，記一筆 config-missing', async () => {
    const stub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const res = await api.request('POST', `/api/trips/${tripT}/notes/lodging-tips/generate`, { as: ownerEmail, json: {} });
    expect(res.status).toBe(202);
    expect(stub).not.toHaveBeenCalled();
    expect(await emailEvents('config-missing')).toHaveLength(1);
  });
});
