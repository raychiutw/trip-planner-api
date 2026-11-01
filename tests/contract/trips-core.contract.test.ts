/**
 * trips-core 路由組的契約測試：實際回應必須符合 OpenAPI 文件裡的 schema（多出未宣告的欄位也算失敗）。
 * schema 一律從 src/schemas/trips-core.ts 直接 import（與 routes/groups/trips-core.ts 文件用的是同一份）。
 *
 * `GET /api/trips*` 為 optional 認證（已發布行程可匿名讀）：成功路徑分別以匿名與成員各打一次。
 * 最後一個 describe 檢查：文件寫的每個非 2xx 狀態碼，在本檔都真的被觸發過並用 ApiError 驗證。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { z } from '@hono/zod-openapi';

// Google Routes／配額鎖的外部邊界 stub（segments、recompute 會用到）
vi.mock('../../src/lib/maps/google-client', () => ({
  computeRoute: vi.fn(async () => ({ polyline: 'mock', distance_meters: 1000, duration_seconds: 600 })),
}));
vi.mock('../../src/lib/maps-lock', () => ({ assertGoogleAvailable: vi.fn(async () => undefined) }));

import { createTestDb } from '../baseline/setup';
import { mockEnv, seedTrip, seedEntry, seedPoi, getDayId, userIdFor } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { serviceToken } from '../baseline/service-token';
import { assertGoogleAvailable } from '../../src/lib/maps-lock';
import { AppError } from '../../src/errors';
import { ApiError } from '../../src/schemas/common';
import { contractIssues, expectContract } from './support';
import * as S from '../../src/schemas/trips-core';

const OWNER = 'tc-owner@test.com';
const STRANGER = 'tc-stranger@test.com';
const PUB = 'tc-pub';
const PRIV = 'tc-priv';
const EMPTY = 'tc-empty';
const DEL = 'tc-del';
const MISSING = 'tc-missing';

let db: D1Database;
let api: Api;
let apiNoKey: Api;
let e1: number;
let e2: number;
let e3: number;

/** 本檔實際觸發過的 (方法 路徑模板 狀態碼)，最後用來對照文件。 */
const hits = new Set<string>();

async function check(
  method: string,
  template: string,
  path: string,
  expected: number,
  schema: z.ZodTypeAny | null,
  options: Parameters<Api['request']>[2] = {},
  client: Api = api,
): Promise<unknown> {
  const res = await client.request(method, path, options);
  const body = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(body)).toBe(expected);
  if (schema) expectContract(schema, body);
  hits.add(`${method} ${template} ${expected}`);
  return body;
}
/** 測試實際送出的 body 也必須符合文件的 body schema（handler 接受 ⇒ 文件也要判定合法）。 */
const good = <T>(schema: z.ZodTypeAny, body: T): T => { expectContract(schema, body); return body; };
/** 對照：handler 實際拒絕的 body，文件的 body schema 也要判定不合法。 */
const bad = <T>(schema: z.ZodTypeAny, body: T): T => { expect(contractIssues(schema, body), '文件 schema 應判定此 body 不合法').not.toEqual([]); return body; };
const err = (m: string, t: string, p: string, status: number, options?: Parameters<Api['request']>[2], client?: Api) =>
  check(m, t, p, status, ApiError, options, client);

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { GOOGLE_MAPS_API_KEY: 'test-key' } as never) });
  apiNoKey = createApi({ env: mockEnv(db) });

  await seedTrip(db, { id: PUB, owner: OWNER, days: 2, published: 1 });
  await seedTrip(db, { id: PRIV, owner: OWNER, days: 1, published: 0 });
  await seedTrip(db, { id: EMPTY, owner: OWNER, days: 1, published: 0 });
  await seedTrip(db, { id: DEL, owner: OWNER, days: 1, published: 0 });
  await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(userIdFor(STRANGER), STRANGER, 'stranger').run();

  const pa = await seedPoi(db, { name: 'tc-A' });
  const pb = await seedPoi(db, { name: 'tc-B' });
  await db.prepare('UPDATE pois SET lat = 26.3, lng = 127.7 WHERE id = ?').bind(pa).run();
  await db.prepare("UPDATE pois SET lat = 26.2, lng = 127.6, status = 'closed', status_reason = '永久歇業' WHERE id = ?").bind(pb).run();
  const day1 = await getDayId(db, PUB, 1);
  e1 = await seedEntry(db, day1, { sortOrder: 1, poiId: pa });
  e2 = await seedEntry(db, day1, { sortOrder: 2, poiId: pb });
  e3 = await seedEntry(db, await getDayId(db, PRIV, 1), { sortOrder: 1, poiId: pa });
});

describe('GET /api/my-trips', () => {
  it('200：列出自己的行程摘要', async () => {
    const body = await check('GET', '/api/my-trips', '/api/my-trips', 200, S.Trips_MyTripList, { as: OWNER }) as unknown[];
    expect(body.length).toBeGreaterThanOrEqual(3);
  });
  it('401：未登入', () => err('GET', '/api/my-trips', '/api/my-trips', 401));
});

describe('GET /api/trips（optional 認證）', () => {
  it('200：匿名只看到已發布行程（且不含擁有者個資）', async () => {
    const body = await check('GET', '/api/trips', '/api/trips', 200, S.Trips_TripList) as Array<{ tripId: string }>;
    expect(body.map((t) => t.tripId)).toContain(PUB);
    expect(body.map((t) => t.tripId)).not.toContain(PRIV);
  });
  it('200：成員呼叫同樣只回已發布行程', async () => {
    const body = await check('GET', '/api/trips', '/api/trips', 200, S.Trips_TripList, { as: OWNER }) as Array<{ tripId: string }>;
    expect(body.map((t) => t.tripId)).not.toContain(PRIV);
  });
  it('200：帶 ops:trips:read 的 service token + all=1 → 含未發布', async () => {
    const token = await serviceToken(db, ['ops:trips:read']);
    const body = await check('GET', '/api/trips', '/api/trips?all=1', 200, S.Trips_TripList, { bearer: token }) as Array<{ tripId: string }>;
    expect(body.map((t) => t.tripId)).toContain(PRIV);
  });
  it('401：無效的 bearer 不會降級成匿名', () => err('GET', '/api/trips', '/api/trips', 401, { bearer: 'bogus-token' }));
});

describe('POST /api/trips', () => {
  it('201：建立行程（含 destinations）', async () => {
    const body = await check('POST', '/api/trips', '/api/trips', 201, S.Trips_CreateResult, {
      as: OWNER,
      json: good(S.Trips_CreateBody, {
        name: '契約測試行程', startDate: '2026-05-01', endDate: '2026-05-03', title: 't', description: 'd', countries: 'JP',
        published: false, data_source: 'manual', lang: 'zh-TW',
        destinations: [{ name: '那霸', lat: 26.2, lng: 127.6, day_quota: 2, sub_areas: ['國際通'] }],
      }),
    }) as { daysCreated: number; destinationsCreated: number };
    expect(body.daysCreated).toBe(3);
    expect(body.destinationsCreated).toBe(1);
  });
  it('400：帶了 id（伺服器產生）／缺必填／日期錯誤', async () => {
    await err('POST', '/api/trips', '/api/trips', 400, { as: OWNER, json: bad(S.Trips_CreateBody, { id: 'x', name: 'n', startDate: '2026-05-01', endDate: '2026-05-02' }) });
    await err('POST', '/api/trips', '/api/trips', 400, { as: OWNER, json: bad(S.Trips_CreateBody, { name: 'n' }) });
    await err('POST', '/api/trips', '/api/trips', 400, { as: OWNER, json: bad(S.Trips_CreateBody, { name: 123, startDate: '2026-05-05', endDate: '2026-05-01' }) });
  });
  it('401：未登入', () => err('POST', '/api/trips', '/api/trips', 401, { json: { name: 'n', startDate: '2026-05-01', endDate: '2026-05-02' } }));
  it('403：受限 token 不可建立行程', () =>
    err('POST', '/api/trips', '/api/trips', 403, { as: OWNER, restrictTrip: PUB, json: { name: 'n', startDate: '2026-05-01', endDate: '2026-05-02' } }));
});

describe('POST /api/trips/import', () => {
  const file = {
    schemaVersion: 1,
    meta: { name: '匯入行程', title: '匯入', description: '匯入說明', lang: 'zh-TW', countries: 'JP', destinations: [{ name: '那霸', lat: 26.2, lng: 127.6, dayQuota: 1, subAreas: ['a'] }] },
    days: [{ dayNum: 1, date: '2026-06-01', dayOfWeek: '一', label: 'D1', timeline: [
      { sortOrder: 1, startTime: '10:00', stopPois: [{ name: '首里城', type: 'attraction', lat: 26.2, lng: 127.7 }] },
      { sortOrder: 2, startTime: '12:00', stopPois: [{ name: '午餐', type: 'restaurant' }] },
    ] }],
    segments: [{ fromEntryIdx: 0, toEntryIdx: 1, mode: 'walking', min: 5, distanceM: 300, source: 'manual' }],
    notes: { flights: [{ airline: 'X', flightNo: '1' }] },
  };
  it('201：匯入成功', async () => {
    const body = await check('POST', '/api/trips/import', '/api/trips/import', 201, S.Trips_ImportResult, { as: OWNER, json: good(S.Trips_ImportBody, file) }) as { daysCreated: number };
    expect(body.daysCreated).toBe(1);
  });
  it('400：版本不對／缺名稱／含不允許的鍵', async () => {
    await err('POST', '/api/trips/import', '/api/trips/import', 400, { as: OWNER, json: bad(S.Trips_ImportBody, { ...file, schemaVersion: 2 }) });
    await err('POST', '/api/trips/import', '/api/trips/import', 400, { as: OWNER, json: { schemaVersion: 1, meta: {}, days: [] } });
    await err('POST', '/api/trips/import', '/api/trips/import', 400, { as: OWNER, json: bad(S.Trips_ImportBody, { ...file, weather: {} }) });
  });
  it('400：原文超過 512KB', () =>
    err('POST', '/api/trips/import', '/api/trips/import', 400, { as: OWNER, json: { ...file, notes: { pad: 'x'.repeat(520 * 1024) } } }));
  it('401：未登入', () => err('POST', '/api/trips/import', '/api/trips/import', 401, { json: file }));
  it('403：受限 token 不可匯入', () => err('POST', '/api/trips/import', '/api/trips/import', 403, { as: OWNER, restrictTrip: PUB, json: file }));
});

describe('GET /api/trips/:id（optional 認證）', () => {
  it('200：匿名讀已發布行程', async () => {
    const body = await check('GET', '/api/trips/{id}', `/api/trips/${PUB}`, 200, S.Trips_Trip) as { id: string; tripId: string };
    expect(body.id).toBe(PUB);
    expect(body.tripId).toBe(PUB);
  });
  it('200：成員讀未發布行程（含 destinations）', async () => {
    await db.prepare("INSERT INTO trip_destinations (trip_id, dest_order, name, lat, lng, day_quota, sub_areas) VALUES (?, 1, '那霸', 26.2, 127.6, 2, '[\"國際通\"]')").bind(PRIV).run();
    const body = await check('GET', '/api/trips/{id}', `/api/trips/${PRIV}`, 200, S.Trips_Trip, { as: OWNER }) as { destinations: Array<{ subAreas: unknown }> };
    expect(body.destinations[0]!.subAreas).toEqual(['國際通']);
  });
  it('401：無效 bearer', () => err('GET', '/api/trips/{id}', `/api/trips/${PUB}`, 401, { bearer: 'bogus-token' }));
  it('403：匿名讀未發布行程（不洩漏行程是否存在）', () => err('GET', '/api/trips/{id}', `/api/trips/${PRIV}`, 403));
  it('404：行程不存在', () => err('GET', '/api/trips/{id}', `/api/trips/${MISSING}`, 404));
});

describe('PUT /api/trips/:id', () => {
  const p = `/api/trips/${PRIV}`;
  it('200：更新欄位與 destinations', async () => {
    await check('PUT', '/api/trips/{id}', p, 200, S.Trips_Ok, { as: OWNER, json: good(S.Trips_UpdateBody, { name: '改名', title: '新標題', description: '新說明', countries: 'JP', published: 0, data_source: 'manual', lang: 'ja', destinations: [{ name: '石垣', lat: 24.3, lng: 124.1, day_quota: 1, sub_areas: ['a'] }] }) });
  });
  it('400：無有效欄位／lang 不合法', async () => {
    await err('PUT', '/api/trips/{id}', p, 400, { as: OWNER, json: bad(S.Trips_UpdateBody, { bogus: 1 }) });
    await err('PUT', '/api/trips/{id}', p, 400, { as: OWNER, json: bad(S.Trips_UpdateBody, { lang: 'fr' }) });
  });
  it('401：未登入', () => err('PUT', '/api/trips/{id}', p, 401, { json: { title: 'x' } }));
  it('403：非成員', () => err('PUT', '/api/trips/{id}', p, 403, { as: STRANGER, json: { title: 'x' } }));
});

describe('DELETE /api/trips/:id', () => {
  it('200：owner 刪除', () => check('DELETE', '/api/trips/{id}', `/api/trips/${DEL}`, 200, S.Trips_Ok, { as: OWNER }));
  it('401：未登入', () => err('DELETE', '/api/trips/{id}', `/api/trips/${PRIV}`, 401));
  it('403：非 owner', () => err('DELETE', '/api/trips/{id}', `/api/trips/${PRIV}`, 403, { as: STRANGER }));
  it('404：行程不存在', () => err('DELETE', '/api/trips/{id}', `/api/trips/${MISSING}`, 404, { as: OWNER }));
});

describe('PUT／DELETE /api/trips/:id/archive', () => {
  const p = `/api/trips/${EMPTY}/archive`;
  const t = '/api/trips/{id}/archive';
  it('200：封存與取消封存', async () => {
    const a = await check('PUT', t, p, 200, S.Trips_ArchiveResult, { as: OWNER }) as { archivedAt: string | null };
    expect(a.archivedAt).not.toBeNull();
    const b = await check('DELETE', t, p, 200, S.Trips_ArchiveResult, { as: OWNER }) as { archivedAt: string | null };
    expect(b.archivedAt).toBeNull();
  });
  it('401：未登入', async () => {
    await err('PUT', t, p, 401);
    await err('DELETE', t, p, 401);
  });
  it('403：非 owner／受限 token', async () => {
    await err('PUT', t, p, 403, { as: STRANGER });
    await err('DELETE', t, p, 403, { as: STRANGER });
    await err('PUT', t, p, 403, { as: OWNER, restrictTrip: EMPTY });
  });
  it('404：行程不存在', async () => {
    await err('PUT', t, `/api/trips/${MISSING}/archive`, 404, { as: OWNER });
    await err('DELETE', t, `/api/trips/${MISSING}/archive`, 404, { as: OWNER });
  });
});

describe('GET /api/trips/:id/audit 與 POST …/audit/:aid/rollback', () => {
  const t = '/api/trips/{id}/audit';
  const rt = '/api/trips/{id}/audit/{aid}/rollback';
  async function auditRow(action: string, table: string, recordId: number | null, diff: unknown, snapshot: unknown = null): Promise<number> {
    const r = await db.prepare('INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, diff_json, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(PUB, table, recordId, action, OWNER, diff === null ? null : JSON.stringify(diff), snapshot === null ? null : JSON.stringify(snapshot)).first<{ id: number }>();
    return r!.id;
  }

  it('200：成員讀稽核紀錄（含 limit、request_id 篩選）', async () => {
    await auditRow('update', 'trip_entries', e1, { description: { old: 'a', new: 'b' } });
    const body = await check('GET', t, `/api/trips/${PUB}/audit`, 200, S.Trips_AuditList, { as: OWNER }) as unknown[];
    expect(body.length).toBeGreaterThan(0);
    await check('GET', t, `/api/trips/${PUB}/audit?limit=1&request_id=1`, 200, S.Trips_AuditList, { as: OWNER });
  });
  it('400：request_id 不是正整數', () => err('GET', t, `/api/trips/${PUB}/audit?request_id=abc`, 400, { as: OWNER }));
  it('401：未登入（這條與 health／health-check 的 GET 一律要登入，登記為 required）', () => err('GET', t, `/api/trips/${PUB}/audit`, 401));
  it('403：非成員', () => err('GET', t, `/api/trips/${PUB}/audit`, 403, { as: STRANGER }));

  it('200：update → 還原舊值', async () => {
    const id = await auditRow('update', 'trip_entries', e1, { description: { old: '舊', new: '新' } });
    const body = await check('POST', rt, `/api/trips/${PUB}/audit/${id}/rollback`, 200, S.Trips_RollbackResult, { as: OWNER }) as { rolledBack: string };
    expect(body.rolledBack).toBe('update->revert');
  });
  it('200：insert → 刪除、delete → 重新插入', async () => {
    const poiId = await seedPoi(db, { name: 'tc-rb' });
    const insId = await auditRow('insert', 'poi_relations', null, null);
    // insert 需要 record_id：建一筆 pois 以外的可刪紀錄 → 用 trip_permissions 以外最簡單的 poi_relations
    await db.prepare('UPDATE audit_log SET table_name = ?, record_id = ? WHERE id = ?').bind('pois', poiId, insId).run();
    const a = await check('POST', rt, `/api/trips/${PUB}/audit/${insId}/rollback`, 200, S.Trips_RollbackResult, { as: OWNER }) as { rolledBack: string };
    expect(a.rolledBack).toBe('insert->delete');
    const delId = await auditRow('delete', 'pois', poiId, null, { id: poiId, type: 'restaurant', name: 'tc-rb' });
    const b = await check('POST', rt, `/api/trips/${PUB}/audit/${delId}/rollback`, 200, S.Trips_RollbackResult, { as: OWNER }) as { rolledBack: string };
    expect(b.rolledBack).toBe('delete->re-insert');
  });
  it('400：資料表不在白名單／缺 diff', async () => {
    const bad = await auditRow('update', 'users', 1, { name: { old: 'a', new: 'b' } });
    await err('POST', rt, `/api/trips/${PUB}/audit/${bad}/rollback`, 400, { as: OWNER });
    const nodiff = await auditRow('update', 'trip_entries', e1, null);
    await err('POST', rt, `/api/trips/${PUB}/audit/${nodiff}/rollback`, 400, { as: OWNER });
  });
  it('401：未登入', () => err('POST', rt, `/api/trips/${PUB}/audit/1/rollback`, 401));
  it('403：非成員', () => err('POST', rt, `/api/trips/${PUB}/audit/1/rollback`, 403, { as: STRANGER }));
  it('404：找不到稽核紀錄', () => err('POST', rt, `/api/trips/${PUB}/audit/999999/rollback`, 404, { as: OWNER }));
  it('409：delete 還原時該 id 已存在', async () => {
    const id = await auditRow('delete', 'trip_entries', e1, null, { id: e1, day_id: 1 });
    await err('POST', rt, `/api/trips/${PUB}/audit/${id}/rollback`, 409, { as: OWNER });
  });
});

describe('GET／POST /api/trips/:id/health-check', () => {
  const t = '/api/trips/{id}/health-check';
  it('200：尚未健檢時 report 為 null', async () => {
    const body = await check('GET', t, `/api/trips/${PUB}/health-check`, 200, S.Trips_HealthCheckResult, { as: OWNER }) as { report: unknown };
    expect(body.report).toBeNull();
  });
  it('202：觸發健檢；200：30 秒內重複觸發回既有 pending；200：GET 取回報告', async () => {
    const created = await check('POST', t, `/api/trips/${PUB}/health-check`, 202, S.Trips_HealthCheckTriggerResult, { as: OWNER }) as { report: { status: string } };
    expect(created.report.status).toBe('pending');
    await check('POST', t, `/api/trips/${PUB}/health-check`, 200, S.Trips_HealthCheckTriggerResult, { as: OWNER });
    await db.prepare("UPDATE trip_health_reports SET findings_json = ?, status = 'completed', completed_at = datetime('now') WHERE trip_id = ?").bind(JSON.stringify([{ severity: 'high', dimension: 'timing', title: 't', description: 'd', action_target: { day: 1, entry_id: e1 } }]), PUB).run();
    const got = await check('GET', t, `/api/trips/${PUB}/health-check`, 200, S.Trips_HealthCheckResult, { as: OWNER }) as { report: { status: string; completedAt: string | null; findings: Array<Record<string, unknown>> } };
    expect(got.report.status).toBe('completed');
    expect(typeof got.report.completedAt).toBe('string');
    expect(got.report.findings[0]!.actionTarget).toEqual({ day: 1, entryId: e1 });
  });
  it('401：未登入', async () => {
    await err('GET', t, `/api/trips/${PUB}/health-check`, 401);
    await err('POST', t, `/api/trips/${PUB}/health-check`, 401);
  });
  it('403：非成員', async () => {
    await err('GET', t, `/api/trips/${PUB}/health-check`, 403, { as: STRANGER });
    await err('POST', t, `/api/trips/${PUB}/health-check`, 403, { as: STRANGER });
  });
  it('422：空行程不可健檢', () => err('POST', t, `/api/trips/${EMPTY}/health-check`, 422, { as: OWNER }));
});

describe('GET /api/trips/:id/health', () => {
  const t = '/api/trips/{id}/health';
  it('200：POI 健康度（鍵名為 snake_case）', async () => {
    const body = await check('GET', t, `/api/trips/${PUB}/health`, 200, S.Trips_TripHealth, { as: OWNER }) as { closed: number; items: unknown[] };
    expect(body.closed).toBe(1);
    expect(body.items).toHaveLength(1);
  });
  it('401：未登入', () => err('GET', t, `/api/trips/${PUB}/health`, 401));
  it('403：非成員', () => err('GET', t, `/api/trips/${PUB}/health`, 403, { as: STRANGER }));
});

describe('交通段 segments', () => {
  const lt = '/api/trips/{id}/segments';
  const st = '/api/trips/{id}/segments/{sid}';
  let sid: number;

  it('POST 201：driving 自動計算', async () => {
    const body = await check('POST', lt, `/api/trips/${PUB}/segments`, 201, S.Trips_Segment, { as: OWNER, json: good(S.Trips_SegmentCreateBody, { from_entry_id: e1, to_entry_id: e2, mode: 'driving' }) }) as { id: number; min: number };
    sid = body.id;
    expect(body.min).toBe(10);
  });
  it('POST 201：transit 手填 min、noTravel 標記', async () => {
    const t = await check('POST', lt, `/api/trips/${PUB}/segments`, 201, S.Trips_Segment, { as: OWNER, json: good(S.Trips_SegmentCreateBody, { from_entry_id: e2, to_entry_id: e1, mode: 'transit', submode: 'bus', min: 15 }) }) as { source: string };
    expect(t.source).toBe('manual');
    const n = await check('POST', lt, `/api/trips/${PUB}/segments`, 201, S.Trips_Segment, { as: OWNER, json: good(S.Trips_SegmentCreateBody, { from_entry_id: e2, to_entry_id: e1, noTravel: true }) }) as { noTravel: number };
    expect(n.noTravel).toBe(1);
  });
  it('POST 400：缺 mode／entry 相同／min 超界', async () => {
    await err('POST', lt, `/api/trips/${PUB}/segments`, 400, { as: OWNER, json: { from_entry_id: e1, to_entry_id: e2 } });
    await err('POST', lt, `/api/trips/${PUB}/segments`, 400, { as: OWNER, json: { from_entry_id: e1, to_entry_id: e1, mode: 'driving' } });
    await err('POST', lt, `/api/trips/${PUB}/segments`, 400, { as: OWNER, json: bad(S.Trips_SegmentCreateBody, { from_entry_id: e1, to_entry_id: e2, mode: 'transit', min: 99999 }) });
  });
  it('POST 401／403／404', async () => {
    await err('POST', lt, `/api/trips/${PUB}/segments`, 401, { json: { from_entry_id: e1, to_entry_id: e2, mode: 'driving' } });
    await err('POST', lt, `/api/trips/${PUB}/segments`, 403, { as: STRANGER, json: { from_entry_id: e1, to_entry_id: e2, mode: 'driving' } });
    await err('POST', lt, `/api/trips/${PUB}/segments`, 404, { as: OWNER, json: { from_entry_id: e1, to_entry_id: e3, mode: 'driving' } });
  });

  it('GET 200：匿名讀已發布行程的交通段；成員亦可', async () => {
    const anon = await check('GET', lt, `/api/trips/${PUB}/segments`, 200, S.Trips_SegmentList) as unknown[];
    expect(anon.length).toBeGreaterThan(0);
    await check('GET', lt, `/api/trips/${PUB}/segments`, 200, S.Trips_SegmentList, { as: OWNER });
    await check('GET', lt, `/api/trips/${PRIV}/segments`, 200, S.Trips_SegmentList, { as: OWNER });
  });
  it('GET 401／403／404', async () => {
    await err('GET', lt, `/api/trips/${PUB}/segments`, 401, { bearer: 'bogus-token' });
    await err('GET', lt, `/api/trips/${PRIV}/segments`, 403);
    await err('GET', lt, `/api/trips/${MISSING}/segments`, 404);
  });

  it('PATCH 200：改 mode；noTravel；版本相符', async () => {
    const p = `/api/trips/${PUB}/segments/${sid}`;
    const a = await check('PATCH', st, p, 200, S.Trips_Segment, { as: OWNER, json: good(S.Trips_SegmentPatchBody, { mode: 'walking', submode: null }) }) as { mode: string; version: number };
    expect(a.mode).toBe('walking');
    await check('PATCH', st, p, 200, S.Trips_Segment, { as: OWNER, json: good(S.Trips_SegmentPatchBody, { mode: 'driving', expectedVersion: a.version }) });
    await check('PATCH', st, p, 200, S.Trips_Segment, { as: OWNER, json: good(S.Trips_SegmentPatchBody, { noTravel: true }) });
  });
  it('PATCH 400／401／403／404／409', async () => {
    const p = `/api/trips/${PUB}/segments/${sid}`;
    await err('PATCH', st, p, 400, { as: OWNER, json: bad(S.Trips_SegmentPatchBody, { mode: 'bogus' }) });
    await err('PATCH', st, p, 401, { json: { mode: 'walking' } });
    await err('PATCH', st, p, 403, { as: STRANGER, json: { mode: 'walking' } });
    await err('PATCH', st, `/api/trips/${PUB}/segments/999999`, 404, { as: OWNER, json: { mode: 'walking' } });
    await err('PATCH', st, p, 409, { as: OWNER, json: good(S.Trips_SegmentPatchBody, { mode: 'walking', expectedVersion: 99999 }) });
  });
});

describe('POST /api/trips/:id/recompute-travel', () => {
  const t = '/api/trips/{id}/recompute-travel';
  it('200：重算交通（全部／指定天）', async () => {
    const all = await check('POST', t, `/api/trips/${PUB}/recompute-travel`, 200, S.Trips_RecomputeResult, { as: OWNER }) as { tripId: string };
    expect(all.tripId).toBe(PUB);
    await check('POST', t, `/api/trips/${PUB}/recompute-travel?day=1`, 200, S.Trips_RecomputeResult, { as: OWNER });
    await check('POST', t, `/api/trips/${PUB}/recompute-travel?day=all`, 200, S.Trips_RecomputeResult, { as: OWNER });
  });
  it('400：day 不合法', () => err('POST', t, `/api/trips/${PUB}/recompute-travel?day=abc`, 400, { as: OWNER }));
  it('401：未登入', () => err('POST', t, `/api/trips/${PUB}/recompute-travel`, 401));
  it('403：非成員', () => err('POST', t, `/api/trips/${PUB}/recompute-travel`, 403, { as: STRANGER }));
  it('502：沒有設定 GOOGLE_MAPS_API_KEY', () => err('POST', t, `/api/trips/${PUB}/recompute-travel`, 502, { as: OWNER }, apiNoKey));
  it('503：本月 Google 配額已用完', async () => {
    vi.mocked(assertGoogleAvailable).mockRejectedValueOnce(new AppError('MAPS_LOCKED'));
    await err('POST', t, `/api/trips/${PUB}/recompute-travel`, 503, { as: OWNER });
  });
});

/* ───────────── 文件本身 ───────────── */

interface Op { requestBody?: unknown; responses?: Record<string, { content?: unknown }>; security?: Array<Record<string, unknown>> }
const ROUTES: Array<{ method: string; path: string; auth: 'required' | 'optional'; body: boolean }> = [
  { method: 'get', path: '/api/my-trips', auth: 'required', body: false },
  { method: 'get', path: '/api/trips', auth: 'optional', body: false },
  { method: 'post', path: '/api/trips', auth: 'required', body: true },
  { method: 'post', path: '/api/trips/import', auth: 'required', body: true },
  { method: 'get', path: '/api/trips/{id}', auth: 'optional', body: false },
  { method: 'put', path: '/api/trips/{id}', auth: 'required', body: true },
  { method: 'delete', path: '/api/trips/{id}', auth: 'required', body: false },
  { method: 'put', path: '/api/trips/{id}/archive', auth: 'required', body: false },
  { method: 'delete', path: '/api/trips/{id}/archive', auth: 'required', body: false },
  { method: 'get', path: '/api/trips/{id}/audit', auth: 'required', body: false },
  { method: 'post', path: '/api/trips/{id}/audit/{aid}/rollback', auth: 'required', body: false },
  { method: 'get', path: '/api/trips/{id}/health-check', auth: 'required', body: false },
  { method: 'post', path: '/api/trips/{id}/health-check', auth: 'required', body: false },
  { method: 'get', path: '/api/trips/{id}/health', auth: 'required', body: false },
  { method: 'post', path: '/api/trips/{id}/recompute-travel', auth: 'required', body: false },
  { method: 'get', path: '/api/trips/{id}/segments', auth: 'optional', body: false },
  { method: 'post', path: '/api/trips/{id}/segments', auth: 'required', body: true },
  { method: 'patch', path: '/api/trips/{id}/segments/{sid}', auth: 'required', body: true },
];

describe('OpenAPI 文件（/openapi.json）', () => {
  let paths: Record<string, Record<string, Op>>;
  beforeAll(async () => {
    const res = await api.get('/openapi.json');
    paths = ((await res.json()) as { paths: typeof paths }).paths;
  });

  it.each(ROUTES)('$method $path 有寫 responses、security 與 requestBody', ({ method, path, auth, body }) => {
    const op = paths[path]?.[method];
    expect(op, '路由要出現在文件').toBeDefined();
    const codes = Object.keys(op!.responses ?? {});
    expect(codes.some((c) => c.startsWith('2')), '要有成功狀態碼').toBe(true);
    // 預設文件只有 200 + z.any()；補過 schema 的路由必須有 2xx 的 JSON schema 或 4xx 的 ApiError
    const withSchema = Object.values(op!.responses!).filter((r) => r.content !== undefined);
    expect(withSchema.length, '至少一個回應要有 schema').toBeGreaterThan(0);
    expect(codes.filter((c) => !c.startsWith('2')).length, '要列出常見錯誤碼').toBeGreaterThan(0);
    expect(op!.security).toEqual(auth === 'required' ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}]);
    if (body) expect(op!.requestBody, '寫入類要有 requestBody').toBeDefined();
    else expect(op!.requestBody).toBeUndefined();
  });

  it('文件列出的每個非 2xx 狀態碼，本檔都實際觸發過並以 ApiError 驗證', () => {
    const missing: string[] = [];
    for (const { method, path } of ROUTES) {
      for (const code of Object.keys(paths[path]?.[method]?.responses ?? {})) {
        if (code.startsWith('2')) continue;
        if (!hits.has(`${method.toUpperCase()} ${path} ${code}`)) missing.push(`${method.toUpperCase()} ${path} ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('文件列出的每個 2xx 狀態碼也都被觸發過', () => {
    const missing: string[] = [];
    for (const { method, path } of ROUTES) {
      for (const code of Object.keys(paths[path]?.[method]?.responses ?? {})) {
        if (!code.startsWith('2')) continue;
        if (!hits.has(`${method.toUpperCase()} ${path} ${code}`)) missing.push(`${method.toUpperCase()} ${path} ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
