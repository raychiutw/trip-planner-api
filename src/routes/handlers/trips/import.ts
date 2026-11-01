/**
 * POST /api/trips/import — create a NEW trip from an exported v1 JSON file.
 *
 * Security: body is attacker-controlled. We enforce the real body size (read
 * text, cap, then parse — never trust Content-Length), run the pure validator
 * (_import.ts: allowlist reads, enum coercion, array + TOTAL caps, sort_order
 * renumber, segment dedup, prototype-pollution rejection), cap trips-per-user,
 * then build only parameterized statements.
 *
 * The new-trip creation module owns chunked writes, generated-ID remapping and
 * compensation. POIs follow the shared fill-null policy; existing non-null
 * values are preserved.
 *
 * Design: ~/.gstack/projects/raychiutw-trip-planner/ray-master-design-20260530-101432.md (PR3)
 */
import type { Env } from '../../../env';
import { requireAuth, assertNotTripRestricted } from '../../../lib/permissions';
import { json } from '../../../lib/utils';
import { AppError } from '../../../errors';
import { parseAndValidateImport, MAX_IMPORT_BYTES, type NImportNotes } from '../../../lib/trip-import';
import { assertTripCap, generateUniqueTripId } from '../../../lib/trip-write';
import { createTripFromPlan, type NewTripPlan } from '../../../lib/create-trip';

type Stmt = D1PreparedStatement;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  // v2.55.56: 受限 token 只做單一 trip 內容編輯 — 不可匯入（建立新 trip）。
  assertNotTripRestricted(auth);
  if (!auth.userId) throw new AppError('AUTH_REQUIRED', '需 V2 OAuth 登入才能匯入行程');

  // Enforce the REAL body size (Content-Length is attacker-controllable / may be
  // absent) — read the text, cap, then parse.
  const text = await context.request.text();
  if (text.length > MAX_IMPORT_BYTES) {
    throw new AppError('DATA_VALIDATION', `匯入檔過大（上限 ${Math.floor(MAX_IMPORT_BYTES / 1024)}KB）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('DATA_VALIDATION', '不是有效的 JSON');
  }

  const result = parseAndValidateImport(raw);
  if (!result.ok) throw new AppError('DATA_VALIDATION', result.error);
  const data = result.data;

  const db = context.env.DB;

  // Cap trips-per-user (anti import-spam DoS).
  await assertTripCap(db, auth.userId);

  const tripId = await generateUniqueTripId(db, data.name);
  const poiData = (p: { type: string; name: string; category: string | null; lat: number | null; lng: number | null; hours: string | null; rating: number | null; price?: string | null; address: string | null; placeId: string | null }) => ({
    type: p.type, name: p.name, category: p.category, lat: p.lat, lng: p.lng, hours: p.hours,
    rating: p.rating, price: p.price ?? null, address: p.address, place_id: p.placeId, source: 'imported',
  });
  const plan: NewTripPlan = {
    tripId, ownerId: auth.userId, name: data.name, title: data.title, description: data.description,
    countries: data.countries ?? 'JP', published: 0, dataSource: 'imported', lang: data.lang,
    destinations: data.destinations.map((d) => ({ ...d, subAreas: d.subAreas ? JSON.stringify(d.subAreas) : null })),
    notes: noteStatements(db, tripId, data.notes),
    days: data.days.map((d, i) => ({
      dayNum: d.dayNum || i + 1, date: d.date, dayOfWeek: d.dayOfWeek, label: d.label,
      hotel: d.hotel ? poiData(d.hotel) : null,
      entries: d.entries.map((e) => ({
        key: e.entryPosition, sortOrder: e.sortOrder, startTime: e.startTime, endTime: e.endTime,
        description: e.description, source: e.source,
        pois: e.pois.map((p) => ({ data: poiData(p), fields: {
          description: p.description, note: p.note, reservation: p.reservation, reservationUrl: p.reservationUrl,
        } })),
      })),
    })),
    segments: data.segments.map((s) => ({ fromKey: s.fromEntryIdx, toKey: s.toEntryIdx,
      mode: s.mode, submode: s.submode, min: s.min, distanceM: s.distanceM, source: s.source, noTravel: s.noTravel })),
    audit: { changedBy: auth.email || auth.userId, diff: { via: 'import' } },
    failureDetail: '匯入失敗，請稍後重試',
  };
  await createTripFromPlan(db, plan);
  return json({ ok: true, tripId, daysCreated: data.days.length }, 201);
};

function noteStatements(db: D1Database, tripId: string, n: NImportNotes): Stmt[] {
  const out: Stmt[] = [];
  for (const f of n.flights) {
    out.push(db.prepare('INSERT INTO trip_flights (trip_id, sort_order, airline, flight_no, cabin_class, depart_airport, arrive_airport, depart_at, arrive_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(tripId, f.sort_order, f.airline, f.flight_no, f.cabin_class, f.depart_airport, f.arrive_airport, f.depart_at, f.arrive_at, f.note));
  }
  for (const l of n.lodgings) {
    out.push(db.prepare('INSERT INTO trip_lodgings (trip_id, sort_order, name, address, check_in_at, check_out_at, booking_no, phone, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(tripId, l.sort_order, l.name, l.address, l.check_in_at, l.check_out_at, l.booking_no, l.phone, l.note));
  }
  for (const r of n.reservations) {
    out.push(db.prepare('INSERT INTO trip_reservations (trip_id, sort_order, kind, title, reserved_at, party_size, reservation_no, phone, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(tripId, r.sort_order, r.kind, r.title, r.reserved_at, r.party_size, r.reservation_no, r.phone, r.note));
  }
  for (const p of n.pretripNotes) {
    out.push(db.prepare('INSERT INTO trip_pretrip_notes (trip_id, sort_order, section, title, content) VALUES (?,?,?,?,?)')
      .bind(tripId, p.sort_order, p.section, p.title, p.content));
  }
  for (const c of n.emergencyContacts) {
    out.push(db.prepare('INSERT INTO trip_emergency_contacts (trip_id, sort_order, name, relationship, phone, email, kind) VALUES (?,?,?,?,?,?,?)')
      .bind(tripId, c.sort_order, c.name, c.relationship, c.phone, c.email, c.kind));
  }
  return out;
}
