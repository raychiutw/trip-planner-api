/**
 * Integration — public share platform endpoints (v2.39.0 PR1)。走 HTTP 邊界（tests/api/http.ts）：
 * 認證用真實 bearer token、匿名讀者不帶任何憑證，全部經過 middleware。
 *
 * Exercises the security-load-bearing handler behaviors that unit tests can't prove:
 *  - default-deny filtering END-TO-END: a closed section (emergency, off by default)
 *    is absent from the public GET even when rows exist;
 *  - cross-trip IDOR: managing a shareId via a DIFFERENT trip's :id → 404;
 *  - viewer-role rejection on create/list/revoke (write-tier capability);
 *  - unknown / revoked token → uniform 404 on the public GET;
 *  - public payload carries no owner email / user_id.
 *
 * 共用 D1：email／trip／POI 一律用 `s15-` 前綴，用專屬 CF-Connecting-IP 隔離 per-IP 限流桶，
 * 結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, getDayId, seedEntry, seedPoi, seedEntryAlternate, seedHotelForDay, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { cleanupS15 } from './cleanup-shares';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const owner = 's15-share-owner@test.com';
const TEST_IP = '198.51.100.151';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  await cleanupS15(db, [TEST_IP]);
});

afterAll(async () => {
  await cleanupS15(db, [TEST_IP]);
  await disposeMiniflare();
});

const ipHeaders = { 'CF-Connecting-IP': TEST_IP };

/** 匿名公開讀取 */
function publicView(token: string): Promise<Response> {
  return api.get(`/api/share/${token}`, { headers: ipHeaders });
}

function createShareFor(tripId: string, ownerEmail = owner, body: Record<string, unknown> = {}) {
  return api.request('POST', `/api/trips/${tripId}/shares`, { as: ownerEmail, json: body });
}

function patchShare(tripId: string, shareId: number | string, body: Record<string, unknown>, email = owner) {
  return api.request('PATCH', `/api/trips/${tripId}/shares/${shareId}`, { as: email, json: body });
}

function listShares(tripId: string, email = owner) {
  return api.get(`/api/trips/${tripId}/shares`, { as: email });
}

function cloneShare(token: string, email: string) {
  return api.request('POST', `/api/share/${token}/clone`, { as: email, headers: ipHeaders });
}

describe('share create + public view (default-deny end-to-end)', () => {
  it('owner creates a link; public GET returns flights (default-on) but NOT emergency (default-off) even though rows exist', async () => {
    const { id } = await seedTrip(db, { id: 's15-share-trip-1', owner, days: 1 });
    await db.prepare("INSERT INTO trip_flights (trip_id, airline, flight_no) VALUES (?, 'BR', '112')").bind(id).run();
    await db.prepare("INSERT INTO trip_emergency_contacts (trip_id, name, phone) VALUES (?, 'Mom', '0900-000')").bind(id).run();

    const createRes = await createShareFor(id);
    expect(createRes.status).toBe(200);
    const created = await createRes.json() as { token: string; url: string };
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(created.url).toBe(`/s/${created.token}`);

    const viewRes = await publicView(created.token);
    expect(viewRes.status).toBe(200);
    const payload = await viewRes.json() as { meta: Record<string, unknown>; notes: Record<string, unknown[]> };

    // flights is in DEFAULT_SHARE_SECTIONS → present; emergency is NOT → empty despite the seeded row
    expect(payload.notes.flights!.length).toBe(1);
    expect(payload.notes.emergencyContacts).toEqual([]);
    expect(payload.notes.reservations).toEqual([]); // also default-off
    // no owner PII in the public payload
    expect(JSON.stringify(payload.meta)).not.toContain('owner_user_id');
    expect(JSON.stringify(payload.meta)).not.toContain('@test.com');
    // 整份匿名回應（含 body、notes）都不含 owner 的 email 與 user id
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(owner);
    expect(wire).not.toContain(userIdFor(owner));
    // security headers
    expect(viewRes.headers.get('Cache-Control')).toContain('no-store');
    expect(viewRes.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('unknown token → 404; revoked token → 404 (uniform)', async () => {
    const unknownRes = await publicView('nonexistenttoken12345');
    expect(unknownRes.status).toBe(404);

    const { id } = await seedTrip(db, { id: 's15-share-trip-revoke', owner, days: 1 });
    const created = await (await createShareFor(id)).json() as { id: number; token: string };
    // revoke it
    const revokeRes = await patchShare(id, created.id, { action: 'revoke' });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await publicView(created.token);
    expect(afterRevoke.status).toBe(404);
  });
});

describe('IDOR — cross-trip share management', () => {
  it('PATCH/DELETE a shareId via a DIFFERENT trip the user also owns → 404 (AND trip_id guard)', async () => {
    const a = await seedTrip(db, { id: 's15-idor-trip-a', owner, days: 1 });
    const b = await seedTrip(db, { id: 's15-idor-trip-b', owner, days: 1 });
    const shareOnA = await (await createShareFor(a.id)).json() as { id: number };

    // owner has write on BOTH a and b; try to revoke A's share via trip B's :id
    const crossRevoke = await patchShare(b.id, shareOnA.id, { action: 'revoke' });
    expect(crossRevoke.status).toBe(404); // belongs to A, not B

    const crossDelete = await api.request('DELETE', `/api/trips/${b.id}/shares/${shareOnA.id}`, { as: owner });
    expect(crossDelete.status).toBe(404);

    // sanity: the share on A is still active (not revoked by the cross-trip attempt)
    const list = await (await listShares(a.id)).json() as { shares: { id: number; revokedAt: string | null }[] };
    expect(list.shares.find((s) => s.id === shareOnA.id)?.revokedAt).toBeNull();
  });
});

describe('IDOR — 跨行程 rotate／update', () => {
  it('用另一個自己也擁有的行程 :id 對 A 的連結 rotate／update → 404，A 的連結原封不動', async () => {
    const a = await seedTrip(db, { id: 's15-idor-rot-a', owner, days: 1 });
    const b = await seedTrip(db, { id: 's15-idor-rot-b', owner, days: 1 });
    const shareOnA = (await (await createShareFor(a.id)).json()) as { id: number; token: string };

    expect((await patchShare(b.id, shareOnA.id, { action: 'rotate' })).status).toBe(404);
    expect((await patchShare(b.id, shareOnA.id, { action: 'update', label: 'hijacked' })).status).toBe(404);

    expect((await publicView(shareOnA.token)).status).toBe(200); // token 沒被換掉
    const row = await db.prepare('SELECT label FROM trip_shares WHERE id = ?').bind(shareOnA.id).first<{ label: string }>();
    expect(row?.label).toBe('');
  });
});

describe('viewer-role rejection (managing shares is write-tier)', () => {
  it('a viewer collaborator cannot create or list share links', async () => {
    const { id } = await seedTrip(db, { id: 's15-viewer-trip', owner, days: 1 });
    const viewerEmail = 's15-viewer@test.com';
    const viewerId = await seedUser(db, viewerEmail);
    await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'viewer')").bind(viewerId, id).run();

    const createAsViewer = await createShareFor(id, viewerEmail);
    expect(createAsViewer.status).toBe(403);

    const listAsViewer = await listShares(id, viewerEmail);
    expect(listAsViewer.status).toBe(403);
  });
});

describe('anonymous share (PR2)', () => {
  it('anonymous link → public payload sharedBy is empty (owner has a name)', async () => {
    const { id } = await seedTrip(db, { id: 's15-anon-trip', owner, days: 1 });
    // non-anon → sharedBy = owner display_name (seedTrip sets it to the email local-part)
    const plain = (await (await createShareFor(id)).json()) as { token: string };
    const p1 = (await (await publicView(plain.token)).json()) as { meta: { sharedBy: string } };
    expect(p1.meta.sharedBy).toBe('s15-share-owner');

    const anon = (await (await createShareFor(id, owner, { anonymous: true })).json()) as { token: string };
    const p2 = (await (await publicView(anon.token)).json()) as { meta: { sharedBy: string } };
    expect(p2.meta.sharedBy).toBe('');
  });
});

describe('rotate token (PR2)', () => {
  it('rotate issues a new token; old 404s, new works', async () => {
    const { id } = await seedTrip(db, { id: 's15-rotate-trip', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };
    const rot = await patchShare(id, created.id, { action: 'rotate' });
    expect(rot.status).toBe(200);
    const { token: newToken } = (await rot.json()) as { token: string };
    expect(newToken).not.toBe(created.token);
    expect((await publicView(created.token)).status).toBe(404);
    expect((await publicView(newToken)).status).toBe(200);
  });
});

describe('clone (PR3)', () => {
  it('clones visible body + visible notes into the cloner account; hidden sections NOT copied', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-src', owner, days: 1 });
    const dayId = await getDayId(db, id, 1);
    const poiId = await seedPoi(db, { name: 's15-那霸機場', type: 'transport' });
    await seedEntry(db, dayId, { poiId });
    await db.prepare("INSERT INTO trip_flights (trip_id, airline, flight_no) VALUES (?, 'BR', '112')").bind(id).run();
    await db.prepare("INSERT INTO trip_emergency_contacts (trip_id, name, phone) VALUES (?, 'Mom', '0900')").bind(id).run();
    const created = (await (await createShareFor(id)).json()) as { token: string }; // default: flights ON, emergency OFF

    const clonerEmail = 's15-cloner@test.com';
    await seedUser(db, clonerEmail);
    const cloneRes = await cloneShare(created.token, clonerEmail);
    expect(cloneRes.status).toBe(201);
    const { tripId: newId } = (await cloneRes.json()) as { tripId: string };

    const ownerRow = await db.prepare('SELECT owner_user_id FROM trips WHERE id = ?').bind(newId).first<{ owner_user_id: string }>();
    expect(ownerRow?.owner_user_id).toBe(userIdFor(clonerEmail));
    const ents = await db.prepare('SELECT COUNT(*) AS c FROM trip_entries e JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ?').bind(newId).first<{ c: number }>();
    expect(ents?.c).toBe(1);
    // #1258：clone 走 entry intake 批次入口 → 每筆 entry 有 audit_log（rollback 讀它）
    const au = await db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE trip_id = ? AND table_name = 'trip_entries' AND action = 'insert'").bind(newId).first<{ c: number }>();
    expect(au?.c).toBe(1);
    const fl = await db.prepare('SELECT COUNT(*) AS c FROM trip_flights WHERE trip_id = ?').bind(newId).first<{ c: number }>();
    expect(fl?.c).toBe(1); // flights default-ON → copied
    const em = await db.prepare('SELECT COUNT(*) AS c FROM trip_emergency_contacts WHERE trip_id = ?').bind(newId).first<{ c: number }>();
    expect(em?.c).toBe(0); // emergency default-OFF → NOT copied (default-deny holds through clone)
  });

  it('clone 撞既有 POI（fill-null）：補 NULL 欄、不覆蓋非 NULL；其他 trip 引用的同一 row 只被補不被改', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-policy', owner, days: 1 });
    const dayId = await getDayId(db, id, 1);
    // 來源 trip 的 POI 帶完整資料；另一個 trip 已引用同 name+type 的既有 row（address NULL、rating 已有值）
    const srcPoi = await db.prepare("INSERT INTO pois (type, name, address, rating) VALUES ('restaurant', 's15-Policy 食堂 clone', '來源地址', 3.0) RETURNING id").first<{ id: number }>();
    await seedEntry(db, dayId, { poiId: srcPoi!.id });
    // 模擬「既有共用 row」：同 name+type 只能有一列（UNIQUE），所以 clone 撞到的就是 srcPoi 自己 → 把它改成部分 NULL 再驗
    await db.prepare('UPDATE pois SET address = NULL, rating = 4.5 WHERE id = ?').bind(srcPoi!.id).run();
    const created = (await (await createShareFor(id)).json()) as { token: string };
    await seedUser(db, 's15-cloner-policy@test.com');
    const res = await cloneShare(created.token, 's15-cloner-policy@test.com');
    expect(res.status).toBe(201);
    const row = await db.prepare('SELECT address, rating FROM pois WHERE id = ?').bind(srcPoi!.id).first<{ address: string | null; rating: number }>();
    // address 來源是 NULL（讀出來也是 NULL）→ 沒東西可補；rating 4.5 不被覆蓋
    expect(row).toEqual({ address: null, rating: 4.5 });
  });

  it('clone of unknown token → 404', async () => {
    const res = await cloneShare('nopetokennopetoken12', 's15-cloner@test.com');
    expect(res.status).toBe(404);
  });
});

describe('clone — remap fidelity (PR3, multi-day + segment + hotel + alternates)', () => {
  it('remaps days/entries/segments to NEW ids, copies hotel + entry POIs with contiguous sort_order', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-rich', owner, days: 2 });
    const d1 = await getDayId(db, id, 1);
    const d2 = await getDayId(db, id, 2);
    const poiA = await seedPoi(db, { name: 's15-景點A', type: 'attraction' });
    const poiB = await seedPoi(db, { name: 's15-景點B-備選', type: 'attraction' });
    const poiC = await seedPoi(db, { name: 's15-景點C', type: 'restaurant' });
    const hotelPoi = await seedPoi(db, { name: 's15-飯店', type: 'hotel' });
    const e1 = await seedEntry(db, d1, { sortOrder: 1, poiId: poiA });
    await seedEntryAlternate(db, { entryId: e1, poiId: poiB, sortOrder: 2 }); // e1 has master + 1 alternate
    const e2 = await seedEntry(db, d2, { sortOrder: 1, poiId: poiC });
    await seedHotelForDay(db, d2, hotelPoi);
    await db.prepare("INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, min, distance_m, source, version) VALUES (?, ?, ?, 'driving', 15, 5000, 'google', 0)").bind(id, e1, e2).run();

    const created = (await (await createShareFor(id)).json()) as { token: string };
    const clonerEmail = 's15-rich-cloner@test.com';
    await seedUser(db, clonerEmail);
    const cloneRes = await cloneShare(created.token, clonerEmail);
    expect(cloneRes.status).toBe(201);
    const { tripId: newId } = (await cloneRes.json()) as { tripId: string };

    // 2 days copied
    const days = await db.prepare('SELECT COUNT(*) AS c FROM trip_days WHERE trip_id = ?').bind(newId).first<{ c: number }>();
    expect(days?.c).toBe(2);
    // segment remapped: 1 segment whose from/to are entries belonging to the NEW trip
    const segs = (await db.prepare('SELECT from_entry_id AS f, to_entry_id AS t FROM trip_segments WHERE trip_id = ?').bind(newId).all()).results as { f: number; t: number }[];
    expect(segs.length).toBe(1);
    const newEntryIds = ((await db.prepare('SELECT e.id FROM trip_entries e JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ?').bind(newId).all()).results as { id: number }[]).map((r) => r.id);
    expect(newEntryIds).toContain(segs[0]!.f);
    expect(newEntryIds).toContain(segs[0]!.t);
    expect(segs[0]!.f).not.toBe(e1); // remapped, not the old id
    // hotel copied onto one day
    const hotelDays = await db.prepare('SELECT COUNT(*) AS c FROM trip_days WHERE trip_id = ? AND hotel_poi_id IS NOT NULL').bind(newId).first<{ c: number }>();
    expect(hotelDays?.c).toBe(1);
    // the 2-POI entry: sort_order contiguous 1,2 + entry_pois_version = 1
    const grp = (await db.prepare('SELECT tep.entry_id AS eid, COUNT(*) AS c, GROUP_CONCAT(tep.sort_order) AS so FROM trip_entry_pois tep JOIN trip_entries e ON e.id = tep.entry_id JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ? GROUP BY tep.entry_id').bind(newId).all()).results as { eid: number; c: number; so: string }[];
    const twoPoi = grp.find((g) => g.c === 2);
    expect(twoPoi).toBeTruthy();
    expect((twoPoi!.so ?? '').split(',').map(Number).sort((a, b) => a - b)).toEqual([1, 2]); // contiguous 1..N
    const ver = await db.prepare('SELECT entry_pois_version AS v FROM trip_entries WHERE id = ?').bind(twoPoi!.eid).first<{ v: number }>();
    expect(ver?.v).toBe(1);
  });

  // v2.55.45 (G12)：clone 必須帶 transit submode，否則複製/分享出去的行程「單軌」段
  // 掉成 generic transit（與 A1 分享面同一完整性要求）。
  it('carries transit submode through clone (v2.55.45)', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-submode', owner, days: 1 });
    const d1 = await getDayId(db, id, 1);
    const pA = await seedPoi(db, { name: 's15-單軌A', type: 'attraction' });
    const pB = await seedPoi(db, { name: 's15-單軌B', type: 'attraction' });
    const e1 = await seedEntry(db, d1, { sortOrder: 1, poiId: pA });
    const e2 = await seedEntry(db, d1, { sortOrder: 2, poiId: pB });
    await db.prepare("INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, version) VALUES (?, ?, ?, 'transit', 'monorail', 15, 6000, 'haversine', 0)").bind(id, e1, e2).run();

    const created = (await (await createShareFor(id)).json()) as { token: string };
    const clonerEmail = 's15-submode-cloner@test.com';
    await seedUser(db, clonerEmail);
    const cloneRes = await cloneShare(created.token, clonerEmail);
    expect(cloneRes.status).toBe(201);
    const { tripId: newId } = (await cloneRes.json()) as { tripId: string };

    const seg = await db.prepare('SELECT mode, submode, source FROM trip_segments WHERE trip_id = ?')
      .bind(newId).first<{ mode: string; submode: string; source: string }>();
    expect(seg).toMatchObject({ mode: 'transit', submode: 'monorail', source: 'haversine' });
  });

  // v2.55.46：clone 必須帶 no_travel（同一地點/免交通），否則複製出去的行程收合段掉回車程。
  it('carries no_travel (同一地點) through clone (v2.55.46)', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-notravel', owner, days: 1 });
    const d1 = await getDayId(db, id, 1);
    const pA = await seedPoi(db, { name: 's15-同地A', type: 'attraction' });
    const pB = await seedPoi(db, { name: 's15-同地B', type: 'attraction' });
    const e1 = await seedEntry(db, d1, { sortOrder: 1, poiId: pA });
    const e2 = await seedEntry(db, d1, { sortOrder: 2, poiId: pB });
    await db.prepare("INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, version, no_travel) VALUES (?, ?, ?, 'walking', NULL, NULL, NULL, 'manual', 0, 1)").bind(id, e1, e2).run();

    const created = (await (await createShareFor(id)).json()) as { token: string };
    const clonerEmail = 's15-notravel-cloner@test.com';
    await seedUser(db, clonerEmail);
    const cloneRes = await cloneShare(created.token, clonerEmail);
    expect(cloneRes.status).toBe(201);
    const { tripId: newId } = (await cloneRes.json()) as { tripId: string };

    const seg = await db.prepare('SELECT no_travel FROM trip_segments WHERE trip_id = ?')
      .bind(newId).first<{ no_travel: number | null }>();
    expect(seg!.no_travel).toBe(1);
  });

  // migration 0078: trip_entries.note 已 DROP，備註改為 per-POI（trip_entry_pois.note）。
  // clone 必須把來源每個正選/備選 POI 各自的 note 原樣帶到 clone 後的 trip_entry_pois，
  // 且 INSERT trip_entries 不可再帶 entry-level note（否則 DROP 後 "no such column"）。
  it('copies per-POI note onto cloned master + alternate trip_entry_pois (migration 0078)', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-note', owner, days: 1 });
    const d1 = await getDayId(db, id, 1);
    const masterPoi = await seedPoi(db, { name: 's15-正選餐廳', type: 'restaurant' });
    const altPoi = await seedPoi(db, { name: 's15-備選餐廳', type: 'restaurant' });
    const e1 = await seedEntry(db, d1, { sortOrder: 1, poiId: masterPoi });
    await seedEntryAlternate(db, { entryId: e1, poiId: altPoi, sortOrder: 2 });
    // 備註掛在 trip_entry_pois（per-POI），不在 trip_entries（已 DROP）。
    await db.prepare('UPDATE trip_entry_pois SET note = ? WHERE entry_id = ? AND poi_id = ?')
      .bind('必點山苦瓜炒麵', e1, masterPoi).run();
    await db.prepare('UPDATE trip_entry_pois SET note = ? WHERE entry_id = ? AND poi_id = ?')
      .bind('週三公休', e1, altPoi).run();

    const created = (await (await createShareFor(id)).json()) as { token: string };
    const clonerEmail = 's15-note-cloner@test.com';
    await seedUser(db, clonerEmail);
    const cloneRes = await cloneShare(created.token, clonerEmail);
    expect(cloneRes.status).toBe(201);
    const { tripId: newId } = (await cloneRes.json()) as { tripId: string };

    // clone 後正選（sort_order=1）與備選（sort_order=2）的 per-POI note 都原樣保留。
    const noteRows = (await db.prepare(
      `SELECT tep.sort_order AS so, tep.note AS note, p.name AS name
         FROM trip_entry_pois tep
         JOIN pois p ON p.id = tep.poi_id
         JOIN trip_entries e ON e.id = tep.entry_id
         JOIN trip_days d ON d.id = e.day_id
        WHERE d.trip_id = ?
        ORDER BY tep.sort_order ASC`,
    ).bind(newId).all()).results as { so: number; note: string | null; name: string }[];
    expect(noteRows.length).toBe(2);
    const master = noteRows.find((r) => r.so === 1);
    const alt = noteRows.find((r) => r.so === 2);
    expect(master?.name).toBe('s15-正選餐廳');
    expect(master?.note).toBe('必點山苦瓜炒麵');
    expect(alt?.name).toBe('s15-備選餐廳');
    expect(alt?.note).toBe('週三公休');
  });
});

describe('rotate guard (PR2 review fix)', () => {
  it('cannot rotate a revoked link (404, no silent resurrection)', async () => {
    const { id } = await seedTrip(db, { id: 's15-rotate-guard', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };
    await patchShare(id, created.id, { action: 'revoke' });
    const rot = await patchShare(id, created.id, { action: 'rotate' });
    expect(rot.status).toBe(404); // revoked → cannot rotate
  });
});

describe('update — edit without new URL (PR-A)', () => {
  it('edits sections/label/anon on an active link; same token, public GET reflects it', async () => {
    const { id } = await seedTrip(db, { id: 's15-update-trip', owner, days: 1 });
    await db.prepare("INSERT INTO trip_emergency_contacts (trip_id, name, phone) VALUES (?, 'Mom', '0900')").bind(id).run();
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };

    // before: emergency default-OFF → not in public payload, owner name shown
    const before = (await (await publicView(created.token)).json()) as { meta: { sharedBy: string }; notes: { emergencyContacts: unknown[] } };
    expect(before.notes.emergencyContacts).toEqual([]);
    expect(before.meta.sharedBy).toBe('s15-share-owner');

    const upd = await patchShare(id, created.id, { action: 'update', visibleSections: ['flights', 'lodgings', 'pretrip', 'emergency'], label: '給爸媽', anonymous: true });
    expect(upd.status).toBe(200);

    // after: SAME token now exposes emergency + is anonymous
    const after = (await (await publicView(created.token)).json()) as { meta: { sharedBy: string }; notes: { emergencyContacts: unknown[] } };
    expect(after.notes.emergencyContacts.length).toBe(1);
    expect(after.meta.sharedBy).toBe('');
    // list reflects label + anonymous
    const list = (await (await listShares(id)).json()) as { shares: { id: number; label: string; anonymous: number }[] };
    const row = list.shares.find((s) => s.id === created.id);
    expect(row?.label).toBe('給爸媽');
    expect(row?.anonymous).toBe(1);
  });

  it('cannot update a revoked link (404)', async () => {
    const { id } = await seedTrip(db, { id: 's15-update-revoked', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number };
    await patchShare(id, created.id, { action: 'revoke' });
    const upd = await patchShare(id, created.id, { action: 'update', label: 'x' });
    expect(upd.status).toBe(404);
  });
});

// ---- 以下為轉 HTTP 邊界時補上的守衛（既有行為，原本沒有斷言；mutation 驗證過）----

describe('default-deny — 五個筆記區塊逐一驗證 + 匿名回應不洩漏', () => {
  async function seedAllNotes(tripId: string) {
    await db.prepare("INSERT INTO trip_flights (trip_id, airline, flight_no) VALUES (?, 'BR', 'S15-FL')").bind(tripId).run();
    await db.prepare("INSERT INTO trip_lodgings (trip_id, name, booking_no) VALUES (?, 'S15-LODGE', 'S15-BOOK')").bind(tripId).run();
    await db.prepare("INSERT INTO trip_reservations (trip_id, kind, title) VALUES (?, 'restaurant', 'S15-RESV')").bind(tripId).run();
    await db.prepare("INSERT INTO trip_pretrip_notes (trip_id, section, title, content) VALUES (?, 'general', 'S15-PRE', 'x')").bind(tripId).run();
    await db.prepare("INSERT INTO trip_emergency_contacts (trip_id, name, phone) VALUES (?, 'S15-EMER', '0900')").bind(tripId).run();
  }

  it('visibleSections 為空 → 匿名回應不含任何筆記區塊的內容', async () => {
    const { id } = await seedTrip(db, { id: 's15-deny-all', owner, days: 1 });
    await seedAllNotes(id);
    const created = (await (await createShareFor(id, owner, { visibleSections: [] })).json()) as { token: string };
    const res = await publicView(created.token);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { notes: Record<string, unknown[]> };
    expect(payload.notes).toEqual({ flights: [], lodgings: [], reservations: [], pretripNotes: [], emergencyContacts: [] });
    const wire = JSON.stringify(payload);
    for (const secret of ['S15-FL', 'S15-LODGE', 'S15-BOOK', 'S15-RESV', 'S15-PRE', 'S15-EMER']) {
      expect(wire).not.toContain(secret);
    }
  });

  it.each([
    ['flights', 'flights', 'S15-FL'],
    ['lodgings', 'lodgings', 'S15-LODGE'],
    ['reservations', 'reservations', 'S15-RESV'],
    ['pretrip', 'pretripNotes', 'S15-PRE'],
    ['emergency', 'emergencyContacts', 'S15-EMER'],
  ])('只開 %s → 只有 %s 有內容，其餘四個區塊仍是空的', async (section, noteKey, marker) => {
    const { id } = await seedTrip(db, { id: `s15-only-${section}`, owner, days: 1 });
    await seedAllNotes(id);
    const created = (await (await createShareFor(id, owner, { visibleSections: [section, 'bogus-section'] })).json()) as { token: string; visibleSections: string[] };
    expect(created.visibleSections).toEqual([section]); // 未知區塊鍵被擋掉
    const payload = (await (await publicView(created.token)).json()) as { notes: Record<string, unknown[]> };
    for (const [key, rows] of Object.entries(payload.notes)) {
      if (key === noteKey) expect(JSON.stringify(rows)).toContain(marker);
      else expect(rows).toEqual([]);
    }
  });
});

describe('管理端點的授權與回應內容', () => {
  it('未登入 → 401；非協作者 → 403；兩者都不會建立連結', async () => {
    const { id } = await seedTrip(db, { id: 's15-auth-trip', owner, days: 1 });
    const anonymous = await api.request('POST', `/api/trips/${id}/shares`, { json: {} });
    expect(anonymous.status).toBe(401);
    const anonymousList = await api.get(`/api/trips/${id}/shares`);
    expect(anonymousList.status).toBe(401);

    const stranger = 's15-stranger@test.com';
    await seedUser(db, stranger);
    expect((await createShareFor(id, stranger)).status).toBe(403);
    expect((await listShares(id, stranger)).status).toBe(403);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM trip_shares WHERE trip_id = ?').bind(id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('只存 token 的 SHA-256；列表回應不含 token 或 token_hash', async () => {
    const { id } = await seedTrip(db, { id: 's15-token-trip', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { token: string };
    const stored = await db.prepare('SELECT token_hash FROM trip_shares WHERE trip_id = ?').bind(id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toBe(created.token);
    const listText = await (await listShares(id)).text();
    expect(listText).not.toContain(created.token);
    expect(listText).not.toContain(stored!.token_hash);
    expect(listText).not.toContain('token_hash');
  });

  it('DELETE 移除連結：公開讀取 404、列表消失；重複刪除 404', async () => {
    const { id } = await seedTrip(db, { id: 's15-delete-trip', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };
    const del = await api.request('DELETE', `/api/trips/${id}/shares/${created.id}`, { as: owner });
    expect(del.status).toBe(200);
    expect((await publicView(created.token)).status).toBe(404);
    const list = (await (await listShares(id)).json()) as { shares: { id: number }[] };
    expect(list.shares.find((s) => s.id === created.id)).toBeUndefined();
    expect((await api.request('DELETE', `/api/trips/${id}/shares/${created.id}`, { as: owner })).status).toBe(404);
  });

  it('viewer 不能 revoke／rotate／update／delete 既有連結', async () => {
    const { id } = await seedTrip(db, { id: 's15-viewer-manage', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };
    const viewerEmail = 's15-viewer2@test.com';
    const viewerId = await seedUser(db, viewerEmail);
    await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'viewer')").bind(viewerId, id).run();
    for (const action of ['revoke', 'rotate', 'update']) {
      expect((await patchShare(id, created.id, { action, label: 'x' }, viewerEmail)).status).toBe(403);
    }
    expect((await api.request('DELETE', `/api/trips/${id}/shares/${created.id}`, { as: viewerEmail })).status).toBe(403);
    expect((await publicView(created.token)).status).toBe(200); // 連結原封不動
  });
});

describe('過期與無效輸入', () => {
  it('已過期的連結：公開讀取 404，且不能 rotate／update', async () => {
    const { id } = await seedTrip(db, { id: 's15-expired-trip', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };
    await db.prepare('UPDATE trip_shares SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, created.id).run();
    expect((await publicView(created.token)).status).toBe(404);
    expect((await patchShare(id, created.id, { action: 'rotate' })).status).toBe(404);
    expect((await patchShare(id, created.id, { action: 'update', label: 'x' })).status).toBe(404);
  });

  it('尚未過期的連結仍可讀；expiresAt 在過去或超過一年 → 視為永久（null）', async () => {
    const { id } = await seedTrip(db, { id: 's15-expiry-trip', owner, days: 1 });
    const future = Date.now() + 3600_000;
    const ok = (await (await createShareFor(id, owner, { expiresAt: future })).json()) as { token: string; expiresAt: number | null };
    expect(ok.expiresAt).toBe(future);
    expect((await publicView(ok.token)).status).toBe(200);
    const past = (await (await createShareFor(id, owner, { expiresAt: Date.now() - 1000 })).json()) as { expiresAt: number | null };
    expect(past.expiresAt).toBeNull();
    const tooFar = (await (await createShareFor(id, owner, { expiresAt: Date.now() + 400 * 86400_000 })).json()) as { expiresAt: number | null };
    expect(tooFar.expiresAt).toBeNull();
  });

  it('格式不合的 token 與沒有內容的 update → 404／400', async () => {
    expect((await publicView('short')).status).toBe(404);
    const { id } = await seedTrip(db, { id: 's15-invalid-trip', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number };
    expect((await patchShare(id, created.id, { action: 'update' })).status).toBe(400);
    expect((await patchShare(id, created.id, { action: 'nonsense' })).status).toBe(400);
  });
});

describe('clone — 授權邊界', () => {
  it('撤銷的分享不能 clone（404）；未登入 clone → 401', async () => {
    const { id } = await seedTrip(db, { id: 's15-clone-access', owner, days: 1 });
    const created = (await (await createShareFor(id)).json()) as { id: number; token: string };
    expect((await api.request('POST', `/api/share/${created.token}/clone`, { headers: ipHeaders })).status).toBe(401);
    const clonerEmail = 's15-access-cloner@test.com';
    await seedUser(db, clonerEmail);
    await patchShare(id, created.id, { action: 'revoke' });
    expect((await cloneShare(created.token, clonerEmail)).status).toBe(404);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM trips WHERE owner_user_id = ? AND data_source = 'cloned'").bind(userIdFor(clonerEmail)).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
