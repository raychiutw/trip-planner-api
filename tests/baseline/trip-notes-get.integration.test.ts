/**
 * Integration tests — GET /api/trips/:id/notes/* (5 sections + aggregator)
 *
 * v2.34.x 行程筆記 PR2 — read endpoints integration verify。
 *
 * Covers:
 *   1. Aggregator GET /notes 一次回 5 section
 *   2. Per-section GET /notes/{flights,lodgings,reservations,pretrip,emergency}
 *   3. Empty trip → 全 [] （不爆）
 *   4. Sort order by sort_order ASC（INSERT 順序與 sort_order 不同 → 按 sort_order 排）
 *   5. camelCase response (deepCamel via json helper)
 *   6. PERM_DENIED 對非授權 user
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTripNotes } from './cleanup-trip-notes';
import type { Env } from '../../src/env';

let db: D1Database;
let env: Env;
let api: Api;
const tripFull = 's13-notes-get-full';
const tripEmpty = 's13-notes-get-empty';
const ownerEmail = 'owner@s13-notes-get.test';
const strangerEmail = 'stranger@s13-notes-get.test';

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
  await seedUser(db, ownerEmail);
  await seedUser(db, strangerEmail);

  // Trip with all 5 sections populated
  await seedTrip(db, { id: tripFull, owner: ownerEmail });
  // Trip with 0 rows
  await seedTrip(db, { id: tripEmpty, owner: ownerEmail });

  // Seed FLIGHTS — 2 rows, INSERT 順序與 sort_order 不同（驗 ORDER BY）
  await db
    .prepare(
      `INSERT INTO trip_flights (trip_id, sort_order, airline, flight_no, depart_airport, arrive_airport)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(tripFull, 1, 'CI', 'CI 123', 'OKA', 'TPE')
    .run();
  await db
    .prepare(
      `INSERT INTO trip_flights (trip_id, sort_order, airline, flight_no, depart_airport, arrive_airport)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(tripFull, 0, 'CI', 'CI 120', 'TPE', 'OKA') // sort_order 0 應該排在前
    .run();

  // LODGINGS — 1 row
  await db
    .prepare(`INSERT INTO trip_lodgings (trip_id, sort_order, name, booking_no) VALUES (?, ?, ?, ?)`)
    .bind(tripFull, 0, '那霸久茂地里士滿酒店', 'BK-7281')
    .run();

  // RESERVATIONS — 1 row
  await db
    .prepare(
      `INSERT INTO trip_reservations (trip_id, sort_order, kind, title, reservation_no) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tripFull, 0, 'restaurant', 'そば処 鶴亀庵', 'R-9182')
    .run();

  // PRETRIP_NOTES — 3 rows (1 manual + 2 AI with different ai_source)
  await db
    .prepare(
      `INSERT INTO trip_pretrip_notes (trip_id, sort_order, title, content) VALUES (?, ?, ?, ?)`,
    )
    .bind(tripFull, 0, '貨幣', 'TWD ≈ 4.8 JPY')
    .run();
  await db
    .prepare(
      `INSERT INTO trip_pretrip_notes (trip_id, sort_order, title, content, ai_generated, ai_source) VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(tripFull, 1, '插頭', 'A 型 110V', 'general-tips')
    .run();
  await db
    .prepare(
      `INSERT INTO trip_pretrip_notes (trip_id, sort_order, title, content, ai_generated, ai_source) VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(tripFull, 2, '住宿附近超商', '步行 3 分', 'lodging-tips')
    .run();

  // EMERGENCY_CONTACTS — 3 rows
  for (const [order, name, phone, kind] of [
    [0, '駐那霸臺北經濟文化辦事處', '+81988628603', 'embassy'],
    [1, '日本警察', '110', 'police'],
    [2, '救護車 / 消防', '119', 'medical'],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO trip_emergency_contacts (trip_id, sort_order, name, phone, kind) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(tripFull, order, name, phone, kind)
      .run();
  }
});

afterAll(async () => {
  await cleanupTripNotes(db, ['s13-notes-get-%'], ['%@s13-notes-get.test']);
  await disposeMiniflare();
});

function callGet(section: string, tripId: string, email: string) {
  const suffix = section ? `/${section}` : '';
  return api.get(`/api/trips/${tripId}/notes${suffix}`, { as: email });
}

describe('GET /api/trips/:id/notes — aggregator', () => {
  it('full trip → 5 section 全有資料', async () => {
    const res = await callGet('', tripFull, ownerEmail);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.flights.length).toBe(2);
    expect(body.lodgings.length).toBe(1);
    expect(body.reservations.length).toBe(1);
    expect(body.pretripNotes.length).toBe(3);
    expect(body.emergencyContacts.length).toBe(3);
  });

  it('empty trip → 5 section 都 []', async () => {
    const res = await callGet('', tripEmpty, ownerEmail);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.flights).toEqual([]);
    expect(body.lodgings).toEqual([]);
    expect(body.reservations).toEqual([]);
    expect(body.pretripNotes).toEqual([]);
    expect(body.emergencyContacts).toEqual([]);
  });

  it('camelCase 對齊 — pretripNotes / emergencyContacts 而非 pretrip_notes / emergency_contacts', async () => {
    const res = await callGet('', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect('pretripNotes' in body).toBe(true);
    expect('emergencyContacts' in body).toBe(true);
    expect('pretrip_notes' in body).toBe(false);
    expect('emergency_contacts' in body).toBe(false);
  });

  it('row 內欄位 camelCase — sortOrder / aiGenerated / aiSource / flightNo / bookingNo', async () => {
    const res = await callGet('', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect('sortOrder' in body.flights[0]).toBe(true);
    expect('flightNo' in body.flights[0]).toBe(true);
    expect('bookingNo' in body.lodgings[0]).toBe(true);
    expect('aiGenerated' in body.pretripNotes[0]).toBe(true);
    expect('aiSource' in body.pretripNotes[0]).toBe(true);
    // snake 不該 leak
    expect('sort_order' in body.flights[0]).toBe(false);
    expect('flight_no' in body.flights[0]).toBe(false);
  });

  it('flights ORDER BY sort_order — CI 120 (sort=0) 排在 CI 123 (sort=1) 前', async () => {
    const res = await callGet('', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect(body.flights[0].flightNo).toBe('CI 120');
    expect(body.flights[1].flightNo).toBe('CI 123');
  });

  it('PERM_DENIED — 非授權 user 拒絕', async () => {
    const res = await callGet('', tripFull, strangerEmail);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/trips/:id/notes/flights — per-section', () => {
  it('return { items: [...] } shape', async () => {
    const res = await callGet('flights', tripFull, ownerEmail);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    expect(body.items[0].flightNo).toBe('CI 120');
  });

  it('empty trip → items=[]', async () => {
    const res = await callGet('flights', tripEmpty, ownerEmail);
    const body = await res.json() as any;
    expect(body.items).toEqual([]);
  });
});

describe('GET /api/trips/:id/notes/lodgings — per-section', () => {
  it('return lodging row', async () => {
    const res = await callGet('lodgings', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect(body.items[0].name).toContain('里士滿');
    expect(body.items[0].bookingNo).toBe('BK-7281');
  });
});

describe('GET /api/trips/:id/notes/reservations — per-section', () => {
  it('return reservation row', async () => {
    const res = await callGet('reservations', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect(body.items[0].kind).toBe('restaurant');
    expect(body.items[0].title).toBe('そば処 鶴亀庵');
  });
});

describe('GET /api/trips/:id/notes/pretrip — per-section + ai_source filter context', () => {
  it('return 3 pretrip notes', async () => {
    const res = await callGet('pretrip', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect(body.items.length).toBe(3);
    expect(body.items[0].title).toBe('貨幣');
    expect(body.items[0].aiSource).toBeNull();
    expect(body.items[1].aiSource).toBe('general-tips');
    expect(body.items[2].aiSource).toBe('lodging-tips');
  });
});

describe('GET /api/trips/:id/notes/emergency — per-section', () => {
  it('return 3 emergency contacts ordered', async () => {
    const res = await callGet('emergency', tripFull, ownerEmail);
    const body = await res.json() as any;
    expect(body.items.length).toBe(3);
    expect(body.items[0].kind).toBe('embassy');
    expect(body.items[1].kind).toBe('police');
    expect(body.items[1].phone).toBe('110');
  });

  it('PERM_DENIED — 非授權 user', async () => {
    const res = await callGet('emergency', tripFull, strangerEmail);
    expect(res.status).toBe(403);
  });
});
