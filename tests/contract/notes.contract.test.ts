/**
 * notes 組（行程筆記）的契約測試：實際回應必須符合文件 schema（多出未宣告的欄位也算失敗），
 * 文件列出的每個錯誤狀態碼都要有實際觸發的路由，且 /openapi.json 對每條路由都有完整描述。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { z } from '@hono/zod-openapi';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip, seedUser } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { createApp } from '../../src/app';
import { ApiError } from '../../src/schemas/common';
import { expectContract } from './support';
import * as S from '../../src/schemas/notes';

const owner = 'owner@docs-notes.test';
const stranger = 'stranger@docs-notes.test';
const trip = 'docs-notes-a';
const otherTrip = 'docs-notes-b';
let db: D1Database;
let api: Api;

/** 實際打過的 (路由, 狀態碼)，最後一個測試拿來對照文件。 */
const hits = new Map<string, Set<number>>();
const BASE = '/api/trips/{id}/notes';

async function call(method: string, tmpl: string, url: string, opts: { as?: string | null; json?: unknown; raw?: string } = {}): Promise<Response> {
  const as = opts.as === undefined ? owner : opts.as;
  let res: Response;
  if (opts.raw !== undefined) {
    const bearer = await api.tokenFor(as ?? owner);
    res = await api.fetch(new Request(new URL(url, 'https://test.com'), { method, headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: opts.raw }));
  } else {
    res = await api.request(method, url, { ...(as ? { as } : {}), json: opts.json });
  }
  const key = `${method.toLowerCase()} ${BASE}${tmpl}`;
  if (!hits.has(key)) hits.set(key, new Set());
  hits.get(key)!.add(res.status);
  return res;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  await seedUser(db, owner);
  await seedUser(db, stranger);
  await seedTrip(db, { id: trip, owner });
  await seedTrip(db, { id: otherTrip, owner });
});
afterAll(async () => { await disposeMiniflare(); });

const SECTIONS = [
  { name: 'flights', row: S.Notes_Flight, input: S.Notes_FlightInput, patchSchema: S.Notes_FlightPatch, create: { sort_order: 0, airline: 'CI', flight_no: 'CI100', cabin_class: 'Y', depart_airport: 'TPE', arrive_airport: 'OKA', depart_at: '2026-07-26T08:00', arrive_at: '2026-07-26T10:30', note: 'n' }, patch: { sort_order: 1, airline: 'BR', flight_no: 'BR101', cabin_class: 'C', depart_airport: 'KHH', arrive_airport: 'NRT', depart_at: '2026-07-27T08:00', arrive_at: '2026-07-27T12:00', note: 'm' } },
  { name: 'lodgings', row: S.Notes_Lodging, input: S.Notes_LodgingInput, patchSchema: S.Notes_LodgingPatch, create: { sort_order: 0, name: 'Hotel', address: 'Naha', check_in_at: '2026-07-26', check_out_at: '2026-07-28', booking_no: 'B1', phone: '+81', note: 'n' }, patch: { sort_order: 1, name: 'Hotel2', address: 'Chatan', check_in_at: '2026-07-27', check_out_at: '2026-07-29', booking_no: 'B2', phone: '+82', note: 'm' } },
  { name: 'reservations', row: S.Notes_Reservation, input: S.Notes_ReservationInput, patchSchema: S.Notes_ReservationPatch, create: { sort_order: 0, kind: 'restaurant', title: 'Sushi', reserved_at: '2026-07-26T19:00', party_size: 2, reservation_no: 'R1', phone: '1', note: 'n' }, patch: { sort_order: 1, kind: 'ticket', title: 'Ramen', reserved_at: '2026-07-27T19:00', party_size: 4, reservation_no: 'R2', phone: '2', note: 'm' }, badKind: { kind: 'bogus' } },
  { name: 'pretrip', row: S.Notes_PretripNote, input: S.Notes_PretripNoteInput, patchSchema: S.Notes_PretripNotePatch, create: { sort_order: 0, section: '貨幣', title: '匯率', content: '- 日圓' }, patch: { sort_order: 1, section: '通訊', title: '匯率2', content: '- eSIM' } },
  { name: 'emergency', row: S.Notes_EmergencyContact, input: S.Notes_EmergencyContactInput, patchSchema: S.Notes_EmergencyContactPatch, create: { sort_order: 0, name: '警察', relationship: '報案', phone: '110', email: 'a@b.c', kind: 'police' }, patch: { sort_order: 1, name: '警察局', relationship: '失竊', phone: '119', email: 'd@e.f', kind: 'medical' }, badKind: { kind: 'bogus' } },
] as const;

describe('五個區段：list／create／patch／reorder／delete', () => {
  for (const s of SECTIONS) {
    describe(s.name, () => {
      const t = `/${s.name}`;
      const url = `/api/trips/${trip}/notes/${s.name}`;
      const rowSchema = s.row;

      it('POST 201 → 列符合 schema；GET 列表符合 schema', async () => {
        expectContract(s.input, s.create); // 送出的 body 必須符合文件的 body schema（欄位填滿）
        const res = await call('POST', t, url, { json: s.create });
        expect(res.status).toBe(201);
        expectContract(rowSchema, await res.json());
        await call('POST', t, url, { json: {} }); // 空 body 也是合法新增
        const list = await call('GET', t, url);
        expect(list.status).toBe(200);
        const body = await list.json();
        expectContract(S.listOf(rowSchema), body);
        expect((body as { items: unknown[] }).items.length).toBe(2);
      });

      it('PATCH 200 → 列符合 schema；reorder 200；', async () => {
        const items = ((await (await call('GET', t, url)).json()) as { items: { id: number; version: number }[] }).items;
        const patchBody = { ...s.patch, expectedVersion: items[0]!.version };
        expectContract(s.patchSchema, patchBody);
        const p = await call('PATCH', `${t}/{rowId}`, `${url}/${items[0]!.id}`, { json: patchBody });
        expect(p.status).toBe(200);
        const patched = await p.json() as Record<string, unknown>;
        expectContract(rowSchema, patched);
        expect(patched.version).toBe(items[0]!.version + 1);
        const reorderBody = { items: [{ id: items[0]!.id, sortOrder: 5 }, { id: items[1]!.id, sortOrder: 4 }] };
        expectContract(S.Notes_ReorderInput, reorderBody);
        const r = await call('PATCH', `${t}/reorder`, `${url}/reorder`, { json: reorderBody });
        expect(r.status).toBe(200);
        expectContract(S.Notes_ReorderResult, await r.json());
      });

      it('PATCH 409（過期版本）、404（不存在的列）、400（rowId 非數字／無有效欄位）', async () => {
        const items = ((await (await call('GET', t, url)).json()) as { items: { id: number }[] }).items;
        const stale = await call('PATCH', `${t}/{rowId}`, `${url}/${items[0]!.id}`, { json: { ...s.patch, expectedVersion: 999 } });
        expect(stale.status).toBe(409);
        expectContract(ApiError, await stale.json());
        const nf = await call('PATCH', `${t}/{rowId}`, `${url}/999999`, { json: s.patch });
        expect(nf.status).toBe(404);
        expectContract(ApiError, await nf.json());
        const bad = await call('PATCH', `${t}/{rowId}`, `${url}/abc`, { json: s.patch });
        expect(bad.status).toBe(400);
        expectContract(ApiError, await bad.json());
        const empty = await call('PATCH', `${t}/{rowId}`, `${url}/${items[0]!.id}`, { json: {} });
        expect(empty.status).toBe(400);
      });

      it('POST／reorder 400', async () => {
        const bad = await call('POST', t, url, { raw: '{oops' });
        expect(bad.status).toBe(400);
        expectContract(ApiError, await bad.json());
        if ('badKind' in s) {
          expect((await call('POST', t, url, { json: s.badKind })).status).toBe(400);
          expect(s.input.safeParse(s.badKind).success, '文件的 body schema 也要判定 enum 不合法').toBe(false);
          expect(s.patchSchema.safeParse(s.badKind).success).toBe(false);
        }
        for (const body of [{ items: [] }, { items: [{ id: 1, sortOrder: 1 }, { id: 1, sortOrder: 2 }] }, { items: [{ id: -1, sortOrder: 0 }] }, { items: [{ id: 1, sortOrder: -1 }] }]) {
          const r = await call('PATCH', `${t}/reorder`, `${url}/reorder`, { json: body });
          expect(r.status).toBe(400);
          expect(S.Notes_ReorderInput.safeParse(body).success, `文件的 reorder schema 也要拒絕 ${JSON.stringify(body)}`).toBe(false);
          expectContract(ApiError, await r.json());
        }
      });

      it('reorder 帶他行程的 id → 403；DELETE 400／404／403 與成功 200', async () => {
        const other = (await (await call('POST', t, `/api/trips/${otherTrip}/notes/${s.name}`, { json: s.create })).json()) as { id: number };
        const r = await call('PATCH', `${t}/reorder`, `${url}/reorder`, { json: { items: [{ id: other.id, sortOrder: 0 }] } });
        expect(r.status).toBe(403);
        const cross = await call('DELETE', `${t}/{rowId}`, `${url}/${other.id}`);
        expect(cross.status).toBe(403);
        expectContract(ApiError, await cross.json());
        expect((await call('DELETE', `${t}/{rowId}`, `${url}/abc`)).status).toBe(400);
        expect((await call('DELETE', `${t}/{rowId}`, `${url}/999999`)).status).toBe(404);
        const mine = ((await (await call('GET', t, url)).json()) as { items: { id: number }[] }).items[0]!;
        const d = await call('DELETE', `${t}/{rowId}`, `${url}/${mine.id}`);
        expect(d.status).toBe(200);
        expectContract(S.Notes_DeleteResult, await d.json());
      });

      it('401（沒帶 token）與 403（無權限者）：所有方法', async () => {
        const row = ((await (await call('POST', t, url, { json: s.create })).json()) as { id: number });
        const targets: [string, string, string, unknown?][] = [
          ['GET', t, url], ['POST', t, url, {}], ['PATCH', `${t}/reorder`, `${url}/reorder`, { items: [{ id: row.id, sortOrder: 0 }] }],
          ['PATCH', `${t}/{rowId}`, `${url}/${row.id}`, s.patch], ['DELETE', `${t}/{rowId}`, `${url}/${row.id}`],
        ];
        for (const [m, tm, u, body] of targets) {
          const anon = await call(m, tm, u, { as: null, json: body });
          expect(anon.status, `${m} ${u} 無 token`).toBe(401);
          expectContract(ApiError, await anon.json());
          const denied = await call(m, tm, u, { as: stranger, json: body });
          expect(denied.status, `${m} ${u} 陌生人`).toBe(403);
          expectContract(ApiError, await denied.json());
        }
      });
    });
  }
});

describe('彙整、AI 狀態', () => {
  it('GET /notes 五區段彙整符合 schema', async () => {
    const res = await call('GET', '', `/api/trips/${trip}/notes`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown[]>;
    expectContract(S.Notes_Aggregate, body);
    expect(body.pretripNotes!.length).toBeGreaterThan(0);
  });

  it('GET /notes/ai-state：全部 idle，再有 job 後仍符合 schema', async () => {
    const idle = await call('GET', '/ai-state', `/api/trips/${trip}/notes/ai-state`);
    expect(idle.status).toBe(200);
    const b = await idle.json();
    expectContract(S.Notes_AiState, b);
    expect((b as { jobs: { status: string }[] }).jobs.every((j) => j.status === 'idle')).toBe(true);
  });

  it('401／403', async () => {
    for (const [tm, u] of [['', `/api/trips/${trip}/notes`], ['/ai-state', `/api/trips/${trip}/notes/ai-state`]] as const) {
      const anon = await call('GET', tm, u, { as: null });
      expect(anon.status).toBe(401);
      expectContract(ApiError, await anon.json());
      const denied = await call('GET', tm, u, { as: stranger });
      expect(denied.status).toBe(403);
      expectContract(ApiError, await denied.json());
    }
  });
});

describe('generate／ai-state（有 job）', () => {
  const gen = `/api/trips/${trip}/notes/tips/generate`;
  it('POST generate：202 新 job；再打一次 200 回既有 job；ai-state 反映 pending', async () => {
    const first = await call('POST', '/{type}/generate', gen);
    expect(first.status).toBe(202);
    const a = await first.json();
    expectContract(S.Notes_GenerateJob, a);
    const second = await call('POST', '/{type}/generate', gen);
    expect(second.status).toBe(200);
    const b = await second.json();
    expectContract(S.Notes_GenerateJob, b);
    expect((b as { jobId: number }).jobId).toBe((a as { jobId: number }).jobId);
    const st = (await (await call('GET', '/ai-state', `/api/trips/${trip}/notes/ai-state`)).json()) as { jobs: { docType: string; status: string }[] };
    expectContract(S.Notes_AiState, st);
    expect(st.jobs.find((j) => j.docType === 'tips')!.status).toBe('pending');
    // 讓 job 進入各種終態，確認 status 轉換（timed_out → timedOut）仍符合 schema
    await db.prepare(`UPDATE trip_note_ai_jobs SET status='timed_out', error_code='X', error_message='m', started_at=datetime('now'), completed_at=datetime('now') WHERE trip_id = ?`).bind(trip).run();
    const st2 = (await (await call('GET', '/ai-state', `/api/trips/${trip}/notes/ai-state`)).json()) as { jobs: { docType: string; status: string }[] };
    expectContract(S.Notes_AiState, st2);
    expect(st2.jobs.find((j) => j.docType === 'tips')!.status).toBe('timedOut');
  });

  it('generate 400（type 不合法）／401／403', async () => {
    const bad = await call('POST', '/{type}/generate', `/api/trips/${trip}/notes/bogus/generate`);
    expect(bad.status).toBe(400);
    expectContract(ApiError, await bad.json());
    expect((await call('POST', '/{type}/generate', gen, { as: null })).status).toBe(401);
    const denied = await call('POST', '/{type}/generate', gen, { as: stranger });
    expect(denied.status).toBe(403);
    expectContract(ApiError, await denied.json());
  });
});

describe('AI 列：maintenance 與排除項', () => {
  let aiRow: { id: number; version: number };
  beforeAll(async () => {
    const r = await db.prepare(`INSERT INTO trip_pretrip_notes (trip_id, section, title, content, ai_generated, ai_source, origin, managed_by, semantic_key) VALUES (?, '通訊', 'SIM', 'c', 1, 'general-tips', 'ai', 'ai', 'tips:通訊sim') RETURNING id, version`).bind(trip).first<{ id: number; version: number }>();
    aiRow = r!;
  });
  const m = (section: string, id: number | string, t = trip) => `/api/trips/${t}/notes/${section}/${id}/maintenance`;
  const MT = '/{section}/{rowId}/maintenance';

  it('maintenance 200（pretrip）→ 列符合 schema；emergency 也符合', async () => {
    const mBody = { managedBy: 'human', expectedVersion: aiRow.version };
    expectContract(S.Notes_MaintenanceInput, mBody);
    const res = await call('PATCH', MT, m('pretrip', aiRow.id), { json: mBody });
    expect(res.status).toBe(200);
    expectContract(S.Notes_MaintenanceRow, await res.json());
    const em = await db.prepare(`INSERT INTO trip_emergency_contacts (trip_id, name, phone, kind, ai_generated, origin, managed_by) VALUES (?, 'X', '1', 'police', 1, 'ai', 'ai') RETURNING id`).bind(trip).first<{ id: number }>();
    const r2 = await call('PATCH', MT, m('emergency', em!.id), { json: { managedBy: 'human', expectedVersion: 0 } });
    expect(r2.status).toBe(200);
    expectContract(S.Notes_MaintenanceRow, await r2.json());
  });

  it('maintenance 400／404／409（兩種）／401／403', async () => {
    const bad = await call('PATCH', MT, m('pretrip', aiRow.id), { json: { managedBy: 'robot', expectedVersion: 0 } });
    expect(bad.status).toBe(400);
    expectContract(ApiError, await bad.json());
    for (const b of [{ managedBy: 'robot', expectedVersion: 0 }, { expectedVersion: 0 }, { managedBy: 'human' }, { managedBy: 'human', expectedVersion: -1 }]) {
      expect((await call('PATCH', MT, m('pretrip', aiRow.id), { json: b })).status).toBe(400);
      expect(S.Notes_MaintenanceInput.safeParse(b).success, `文件 schema 也要拒絕 ${JSON.stringify(b)}`).toBe(false);
    }
    expect((await call('PATCH', MT, m('flights', aiRow.id), { json: { managedBy: 'human', expectedVersion: 0 } })).status).toBe(400);
    const nf = await call('PATCH', MT, m('pretrip', 999999), { json: { managedBy: 'human', expectedVersion: 0 } });
    expect(nf.status).toBe(404);
    expectContract(ApiError, await nf.json());
    const stale = await call('PATCH', MT, m('pretrip', aiRow.id), { json: { managedBy: 'human', expectedVersion: 999 } });
    expect(stale.status).toBe(409);
    expectContract(ApiError, await stale.json());
    const human = await db.prepare(`INSERT INTO trip_pretrip_notes (trip_id, title) VALUES (?, 'manual') RETURNING id`).bind(trip).first<{ id: number }>();
    const notAi = await call('PATCH', MT, m('pretrip', human!.id), { json: { managedBy: 'ai', expectedVersion: 0 } });
    expect(notAi.status).toBe(409);
    expectContract(ApiError, await notAi.json());
    expect((await call('PATCH', MT, m('pretrip', aiRow.id), { as: null, json: {} })).status).toBe(401);
    const denied = await call('PATCH', MT, m('pretrip', aiRow.id), { as: stranger, json: { managedBy: 'human', expectedVersion: 0 } });
    expect(denied.status).toBe(403);
    expectContract(ApiError, await denied.json());
  });

  it('刪除 AI 列 → excluded:true 並出現在排除項列表；刪除排除項 200／404／400／401／403', async () => {
    const ai = await db.prepare(`INSERT INTO trip_pretrip_notes (trip_id, section, title, content, ai_generated, ai_source, origin, managed_by, semantic_key) VALUES (?, '禮儀', '小費', 'c', 1, 'general-tips', 'ai', 'ai', 'tips:禮儀小費') RETURNING id`).bind(trip).first<{ id: number }>();
    const del = await call('DELETE', '/{section}/{rowId}'.replace('{section}', 'pretrip'), `/api/trips/${trip}/notes/pretrip/${ai!.id}`);
    expect(del.status).toBe(200);
    const dbody = await del.json();
    expectContract(S.Notes_DeleteResult, dbody);
    expect((dbody as { excluded: boolean }).excluded).toBe(true);

    const ex = `/api/trips/${trip}/notes/tips/exclusions`;
    const list = await call('GET', '/{type}/exclusions', ex);
    expect(list.status).toBe(200);
    const lb = await list.json() as { items: { id: number }[] };
    expectContract(S.listOf(S.Notes_Exclusion), lb);
    expect(lb.items.length).toBeGreaterThan(0);
    expect((await call('GET', '/{type}/exclusions', `/api/trips/${trip}/notes/bogus/exclusions`)).status).toBe(400);
    expect((await call('GET', '/{type}/exclusions', ex, { as: null })).status).toBe(401);
    const denied = await call('GET', '/{type}/exclusions', ex, { as: stranger });
    expect(denied.status).toBe(403);
    expectContract(ApiError, await denied.json());

    const XT = '/{type}/exclusions/{exclusionId}';
    const id = lb.items[0]!.id;
    expect((await call('DELETE', XT, `${ex}/abc`)).status).toBe(400);
    expect((await call('DELETE', XT, `${ex}/${id}`, { as: null })).status).toBe(401);
    const d403 = await call('DELETE', XT, `${ex}/${id}`, { as: stranger });
    expect(d403.status).toBe(403);
    expectContract(ApiError, await d403.json());
    const ok = await call('DELETE', XT, `${ex}/${id}`);
    expect(ok.status).toBe(200);
    expectContract(S.Notes_Ok, await ok.json());
    const gone = await call('DELETE', XT, `${ex}/${id}`);
    expect(gone.status).toBe(404);
    expectContract(ApiError, await gone.json());
  });
});

type Op = { requestBody?: unknown; security?: unknown[]; responses?: Record<string, { content?: unknown }> };
const sectionNames = SECTIONS.map((s) => s.name);
const EXPECTED: { method: string; path: string; body: boolean }[] = [
  { method: 'get', path: BASE, body: false },
  { method: 'get', path: `${BASE}/ai-state`, body: false },
  ...sectionNames.flatMap((n) => [
    { method: 'get', path: `${BASE}/${n}`, body: false },
    { method: 'post', path: `${BASE}/${n}`, body: true },
    { method: 'patch', path: `${BASE}/${n}/reorder`, body: true },
    { method: 'patch', path: `${BASE}/${n}/{rowId}`, body: true },
    { method: 'delete', path: `${BASE}/${n}/{rowId}`, body: false },
  ]),
  { method: 'patch', path: `${BASE}/{section}/{rowId}/maintenance`, body: true },
  { method: 'get', path: `${BASE}/{type}/exclusions`, body: false },
  { method: 'delete', path: `${BASE}/{type}/exclusions/{exclusionId}`, body: false },
  { method: 'post', path: `${BASE}/{type}/generate`, body: false },
];

describe('/openapi.json 對每條 notes 路由都有完整文件', () => {
  let paths: Record<string, Record<string, Op>>;
  beforeAll(async () => {
    const res = await createApp().fetch(new Request('https://test.com/openapi.json'), mockEnv(db));
    paths = ((await res.json()) as { paths: typeof paths }).paths;
  });

  it('31 條路由（方法＋路徑）都存在、security 與 auth: required 一致', () => {
    expect(EXPECTED.length).toBe(31);
    for (const e of EXPECTED) {
      const op = paths[e.path]?.[e.method];
      expect(op, `${e.method} ${e.path} 缺文件`).toBeDefined();
      expect(op!.security, `${e.method} ${e.path} security`).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('寫入類有 requestBody；每條路由至少一個有 schema 的成功回應', () => {
    for (const e of EXPECTED) {
      const op = paths[e.path]?.[e.method];
      if (!op) continue;
      if (e.body) expect(op.requestBody, `${e.method} ${e.path} 缺 requestBody`).toBeDefined();
      else expect(op.requestBody, `${e.method} ${e.path} 不該有 requestBody`).toBeUndefined();
      const ok = Object.entries(op.responses ?? {}).filter(([c, r]) => c.startsWith('2') && r.content);
      expect(ok.length, `${e.method} ${e.path} 沒有帶 schema 的成功回應`).toBeGreaterThan(0);
    }
  });

  it('文件列出的每個狀態碼都被實際觸發過（沒有列了但不會發生的）', () => {
    for (const e of EXPECTED) {
      const op = paths[e.path]?.[e.method];
      if (!op) continue;
      const got = hits.get(`${e.method} ${e.path}`) ?? new Set<number>();
      for (const code of Object.keys(op.responses ?? {})) {
        expect(got.has(Number(code)), `${e.method} ${e.path} 文件列 ${code} 但測試沒觸發`).toBe(true);
      }
    }
  });
});
