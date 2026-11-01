/**
 * POST /api/share/:token/clone — copy a shared trip into the caller's account (v2.40.0 PR3).
 *
 * Auth REQUIRED (middleware only bypasses GET /api/share/*; POST falls through to auth).
 * Copies the always-public trip BODY (days / entries / POIs / segments) + ONLY the
 * share's VISIBLE note sections (default-deny via parseVisibleSections) — a private
 * section the owner didn't enable can never reach the clone. New trip owned by the
 * caller (data_source='cloned', published=0). POIs use fill-null. Per-user rate
 * limit + trips cap precede the shared new-trip creation and compensation flow.
 */
import { requireAuth, assertNotTripRestricted } from '../../../../lib/permissions';
import { json } from '../../../../lib/utils';
import { AppError } from '../../../../errors';
import { resolveActiveShare, parseVisibleSections, type ShareSection } from '../../../../lib/share';
import { assertTripCap } from '../../../../lib/trip-write';
import { createTripFromPlan, type NewTripPlan } from '../../../../lib/create-trip';
import type { FindOrCreatePoiData } from '../../../../lib/poi';
import { checkRateLimit, bumpRateLimit, clientIp, RATE_LIMITS } from '../../../../lib/rate-limit';
import type { Env } from '../../../../env';

type Stmt = D1PreparedStatement;
type Row = Record<string, unknown>;
const rows = (r: { results?: unknown[] } | null): Row[] => (r?.results as Row[]) ?? [];
// clone 與匯入同 policy=fill-null（spec #1255 / #1258，owner 2026-09-05 拍板）：撞既有 master 只補 NULL 欄；source='imported'、country 不猜。
const poiFrom = (r: Row): FindOrCreatePoiData => ({
  type: String(r.type ?? 'attraction'),
  name: String(r.name ?? ''),
  category: (r.category as string) ?? null,
  lat: (r.lat as number) ?? null,
  lng: (r.lng as number) ?? null,
  hours: (r.hours as string) ?? null,
  rating: (r.rating as number) ?? null,
  price: (r.price as string) ?? null,
  address: (r.address as string) ?? null,
  place_id: (r.place_id as string) ?? null,
  source: 'imported',
});

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  // v2.55.56: 受限 token 只做單一 trip 內容編輯 — 不可 clone（建立新 trip）。
  assertNotTripRestricted(auth);
  if (!auth.userId) throw new AppError('AUTH_REQUIRED', '需登入才能複製行程');
  const { token } = context.params as { token: string };
  const db = context.env.DB;

  const share = await resolveActiveShare(db, token);
  if (!share) return notFound(); // unknown / revoked / expired — uniform 404

  // Rate limit: per-IP pre-gate (defence-in-depth) + per-user, then absolute trip cap.
  // Count the ATTEMPT up-front (await, not fire-and-forget) — a failing clone still burns
  // hundreds of D1 subrequests, and concurrent requests serialize against a committed count.
  const ipBucket = `clone:ip:${clientIp(context.request)}`;
  const ipRl = await checkRateLimit(db, ipBucket, RATE_LIMITS.CLONE_PER_IP);
  if (!ipRl.ok) {
    return new Response(JSON.stringify({ error: 'RATE_LIMIT' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(ipRl.retryAfter ?? 3600) },
    });
  }
  const bucket = `clone:user:${auth.userId}`;
  const rl = await checkRateLimit(db, bucket, RATE_LIMITS.CLONE_PER_USER);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'RATE_LIMIT' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter ?? 3600) },
    });
  }
  await bumpRateLimit(db, ipBucket, RATE_LIMITS.CLONE_PER_IP);
  await bumpRateLimit(db, bucket, RATE_LIMITS.CLONE_PER_USER);
  await assertTripCap(db, auth.userId);

  const src = share.trip_id;
  const visible = parseVisibleSections(share.visible_sections);
  const wants = (s: ShareSection) => visible.includes(s);
  const noteRead = (table: string, on: boolean) =>
    on ? db.prepare(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY sort_order ASC, id ASC`).bind(src).all() : Promise.resolve(null);

  // Read the source: trip meta + body (always-public) + ONLY the visible note tables.
  const [trip, destsR, daysR, entriesR, epR, hotelsR, segsR, flightsR, lodgingsR, resvR, pretripR, emergR] = await Promise.all([
    db.prepare('SELECT name, title, description, countries, lang FROM trips WHERE id = ?').bind(src)
      .first<{ name: string | null; title: string | null; description: string | null; countries: string | null; lang: string | null }>(),
    db.prepare('SELECT name, lat, lng, day_quota, sub_areas FROM trip_destinations WHERE trip_id = ? ORDER BY dest_order ASC').bind(src).all(),
    db.prepare('SELECT id, day_num, date, day_of_week, label FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC').bind(src).all(),
    // migration 0078: trip_entries.note DROPPED — 不再 SELECT e.note（保留會在 DROP 後
    // "no such column"）。per-POI 備註從 epR 的 tep.note 帶過去（見下方 trip_entry_pois copy）。
    db.prepare('SELECT e.id, e.day_id, e.sort_order, e.start_time, e.end_time, e.description, e.source FROM trip_entries e JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ? ORDER BY e.day_id ASC, e.sort_order ASC').bind(src).all(),
    db.prepare('SELECT tep.entry_id, tep.sort_order, tep.description, tep.note, tep.reservation, tep.reservation_url, p.type, p.name, p.category, p.lat, p.lng, p.hours, p.rating, p.price, p.address, p.place_id FROM trip_entry_pois tep JOIN pois p ON p.id = tep.poi_id JOIN trip_entries e ON e.id = tep.entry_id JOIN trip_days d ON d.id = e.day_id WHERE d.trip_id = ? ORDER BY tep.entry_id ASC, tep.sort_order ASC').bind(src).all(),
    db.prepare('SELECT td.id AS day_id, p.type, p.name, p.category, p.lat, p.lng, p.hours, p.rating, p.price, p.address, p.place_id FROM trip_days td JOIN pois p ON p.id = td.hotel_poi_id WHERE td.trip_id = ?').bind(src).all(),
    db.prepare('SELECT from_entry_id, to_entry_id, mode, submode, min, distance_m, source, no_travel FROM trip_segments WHERE trip_id = ?').bind(src).all(),
    noteRead('trip_flights', wants('flights')),
    noteRead('trip_lodgings', wants('lodgings')),
    noteRead('trip_reservations', wants('reservations')),
    noteRead('trip_pretrip_notes', wants('pretrip')),
    noteRead('trip_emergency_contacts', wants('emergency')),
  ]);
  if (!trip) return notFound();

  const tripId = `cln-${crypto.randomUUID()}`;

  // Map a note row to its INSERT (content columns only — never id / trip_id / timestamps).
  function noteStmts(): Stmt[] {
    const out: Stmt[] = [];
    rows(flightsR).forEach((f, i) => out.push(db.prepare('INSERT INTO trip_flights (trip_id, sort_order, airline, flight_no, cabin_class, depart_airport, arrive_airport, depart_at, arrive_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(tripId, i, f.airline, f.flight_no, f.cabin_class, f.depart_airport, f.arrive_airport, f.depart_at, f.arrive_at, f.note)));
    rows(lodgingsR).forEach((l, i) => out.push(db.prepare('INSERT INTO trip_lodgings (trip_id, sort_order, name, address, check_in_at, check_out_at, booking_no, phone, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(tripId, i, l.name, l.address, l.check_in_at, l.check_out_at, l.booking_no, l.phone, l.note)));
    rows(resvR).forEach((r, i) => out.push(db.prepare('INSERT INTO trip_reservations (trip_id, sort_order, kind, title, reserved_at, party_size, reservation_no, phone, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(tripId, i, r.kind, r.title, r.reserved_at, r.party_size, r.reservation_no, r.phone, r.note)));
    rows(pretripR).forEach((p, i) => out.push(db.prepare('INSERT INTO trip_pretrip_notes (trip_id, sort_order, section, title, content, ai_generated, ai_source) VALUES (?,?,?,?,?,?,?)')
      .bind(tripId, i, p.section, p.title, p.content, p.ai_generated ?? 0, p.ai_source ?? null)));
    rows(emergR).forEach((c, i) => out.push(db.prepare('INSERT INTO trip_emergency_contacts (trip_id, sort_order, name, relationship, phone, email, kind, ai_generated) VALUES (?,?,?,?,?,?,?,?)')
      .bind(tripId, i, c.name, c.relationship, c.phone, c.email, c.kind ?? 'other', c.ai_generated ?? 0)));
    return out;
  }

  const days: NewTripPlan['days'] = rows(daysR).map((d) => ({
    dayNum: d.day_num as number, date: d.date as string, dayOfWeek: d.day_of_week as string,
    label: d.label as string, hotel: null, entries: [],
  }));
  const dayById = new Map(rows(daysR).map((d, i) => [d.id as number, days[i]!]));
  const poisByEntry = new Map<number, NewTripPlan['days'][number]['entries'][number]['pois']>();
  for (const ep of rows(epR)) {
    const list = poisByEntry.get(ep.entry_id as number) ?? [];
    list.push({ data: poiFrom(ep), fields: {
      description: ep.description as string | null, note: ep.note as string | null,
      reservation: ep.reservation as string | null, reservationUrl: ep.reservation_url as string | null,
    } });
    poisByEntry.set(ep.entry_id as number, list);
  }
  for (const e of rows(entriesR)) {
    const day = dayById.get(e.day_id as number);
    if (!day) throw new AppError('SYS_DB_ERROR', '複製寫入失敗（entry 缺 day 關聯）');
    day.entries.push({
      key: e.id as number, sortOrder: e.sort_order as number, startTime: e.start_time as string | null,
      endTime: e.end_time as string | null, description: e.description as string | null,
      source: e.source as string | null, pois: poisByEntry.get(e.id as number) ?? [],
    });
  }
  for (const h of rows(hotelsR)) {
    const day = dayById.get(h.day_id as number);
    if (day) day.hotel = poiFrom(h);
  }
  const plan: NewTripPlan = {
    tripId, ownerId: auth.userId,
    name: `${trip.name ?? '未命名行程'}-複製`, title: trip.title ? `${trip.title}-複製` : null,
    description: trip.description, countries: trip.countries ?? 'JP', published: 0,
    dataSource: 'cloned', lang: trip.lang ?? 'zh-TW',
    destinations: rows(destsR).map((d) => ({ name: d.name as string, lat: d.lat as number | null,
      lng: d.lng as number | null, dayQuota: (d.day_quota as number | null) ?? 0,
      subAreas: (d.sub_areas as string | null) ?? null })),
    notes: noteStmts(), days,
    segments: rows(segsR).map((s) => ({ fromKey: s.from_entry_id as number, toKey: s.to_entry_id as number,
      mode: s.mode as string, submode: (s.submode as string | null) ?? null, min: s.min as number | null,
      distanceM: s.distance_m as number | null, source: s.source as string | null,
      noTravel: s.no_travel === 1 ? 1 : null })),
    audit: { changedBy: auth.email || auth.userId, diff: { via: 'share-clone', sourceTripId: src } },
    failureDetail: '複製失敗，請稍後重試',
  };
  await createTripFromPlan(db, plan);
  return json({ ok: true, tripId, daysCreated: days.length }, 201);
};
