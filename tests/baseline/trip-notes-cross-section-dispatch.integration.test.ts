/**
 * Integration test — v2.34.40 PR40 (PR35 P1 gap)
 *
 * trip-notes feature 4 個 section (lodgings/reservations/pretrip/emergency) 的
 * /[rowId] + /reorder + parent endpoint handler 雖然共用 _shared.ts，但 dispatch
 * 對應 table name 是否正確？trip-notes-mutations.integration.test.ts 只 cover
 * flights/* path，剩 4 section 等於沒驗 dispatch。
 *
 * Cross-section parametrized test：4 個 section × POST → row 進對應 table。
 * 避免 16 個重複 test，只驗 dispatch 正確性而非完整 CRUD（後者 _shared.ts 已測）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTripNotes } from './cleanup-trip-notes';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const ownerEmail = 'owner@s13-notes-dispatch.test';
const tripId = 's13-notes-dispatch';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  await seedUser(db, ownerEmail);
  await seedTrip(db, { id: tripId, owner: ownerEmail });
});

afterAll(async () => {
  await cleanupTripNotes(db, ['s13-notes-dispatch%'], ['%@s13-notes-dispatch.test']);
  await disposeMiniflare();
});

interface Section {
  name: string;
  table: string;
  /** /api/trips/:id/notes/ 之後的 section 路徑 */
  path: string;
  sampleBody: Record<string, unknown>;
}

const SECTIONS: Section[] = [
  {
    name: 'lodgings',
    table: 'trip_lodgings',
    path: 'lodgings',
    sampleBody: { name: 'PR40 飯店', address: '東京都' },
  },
  {
    name: 'reservations',
    table: 'trip_reservations',
    path: 'reservations',
    sampleBody: { title: 'PR40 訂位', kind: 'restaurant' },
  },
  {
    name: 'pretrip',
    table: 'trip_pretrip_notes',
    path: 'pretrip',
    sampleBody: { title: 'PR40 行前須知', content: 'test content', section: '一般' },
  },
  {
    name: 'emergency',
    table: 'trip_emergency_contacts',
    path: 'emergency',
    sampleBody: { name: 'PR40 急救', phone: '110', kind: 'police' },
  },
];

const owner = () => ownerEmail;
const base = (section: string) => `/api/trips/${tripId}/notes/${section}`;
const callPost = (section: string, body: Record<string, unknown>) =>
  api.request('POST', base(section), { as: owner(), json: body });
const callPatch = (section: string, body: Record<string, unknown>, rowId: number) =>
  api.request('PATCH', `${base(section)}/${rowId}`, { as: owner(), json: body });
const callDelete = (section: string, rowId: number) =>
  api.request('DELETE', `${base(section)}/${rowId}`, { as: owner() });
const callReorder = (section: string, items: Array<{ id: number; sortOrder: number }>) =>
  api.request('PATCH', `${base(section)}/reorder`, { as: owner(), json: { items } });

describe('PR40 — trip-notes cross-section dispatch (4 sections × 4 ops = 16 assertions)', () => {
  for (const sec of SECTIONS) {
    describe(`${sec.name} (${sec.table})`, () => {
      let createdRowId: number;

      it(`POST → 201 + row 進 ${sec.table}`, async () => {
        const res = await callPost(sec.path, sec.sampleBody);
        expect(res.status).toBe(201);
        const row = await res.json() as { id: number };
        createdRowId = row.id;
        const found = await db.prepare(`SELECT id FROM ${sec.table} WHERE id = ?`).bind(row.id).first();
        expect(found).not.toBeNull();
      });

      it(`PATCH /[rowId] → 200 + version 加 1`, async () => {
        // 取出 version 改變前的值
        const before = await db.prepare(`SELECT version FROM ${sec.table} WHERE id = ?`).bind(createdRowId).first<{ version: number }>();
        // PATCH 用 section-specific 欄位（依 sampleBody 第一個 key）
        const firstKey = Object.keys(sec.sampleBody)[0]!;
        const res = await callPatch(sec.path, { [firstKey]: 'PR40 updated' }, createdRowId);
        expect(res.status).toBe(200);
        const after = await db.prepare(`SELECT version FROM ${sec.table} WHERE id = ?`).bind(createdRowId).first<{ version: number }>();
        expect(after!.version).toBe(before!.version + 1);
      });

      it(`PATCH /reorder → 200 + audit_log written`, async () => {
        const auditBefore = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE trip_id = ? AND table_name = ?`).bind(tripId, sec.table).first<{ n: number }>();
        const res = await callReorder(sec.path, [{ id: createdRowId, sortOrder: 0 }]);
        expect(res.status).toBe(200);
        const auditAfter = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE trip_id = ? AND table_name = ?`).bind(tripId, sec.table).first<{ n: number }>();
        expect(auditAfter!.n).toBeGreaterThan(auditBefore!.n);
      });

      it(`DELETE /[rowId] → 200 + row 從 ${sec.table} 消失`, async () => {
        const res = await callDelete(sec.path, createdRowId);
        expect(res.status).toBe(200);
        const found = await db.prepare(`SELECT id FROM ${sec.table} WHERE id = ?`).bind(createdRowId).first();
        expect(found).toBeNull();
      });
    });
  }
});
