/**
 * _import.ts — pure validation + normalization for POST /api/trips/import.
 *
 * The import body is ATTACKER-CONTROLLED JSON. This module is the security
 * boundary: it never spreads parsed objects, reads every field through an
 * explicit allowlist, coerces enum columns to satisfy D1 CHECK constraints,
 * caps every array, and rejects prototype-pollution keys. The DB orchestration
 * (import.ts) only ever sees the normalized, safe shape returned here.
 *
 * Round-trip contract: consumes the v1 export from src/lib/tripExport.ts
 * (buildTripExportJson) — camelCase throughout (apiFetch deep-camels responses).
 */
import { normalizeReservation } from './reservation';

export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_DAYS = 366;
export const MAX_ENTRIES_PER_DAY = 100;
export const MAX_POIS_PER_ENTRY = 20;
export const MAX_SEGMENTS = 3000;
export const MAX_NOTES_PER_SECTION = 100;
// Aligned with the PUT /trips/:id create/edit cap (30). A 50 cap here let an
// import create a 31-50 destination trip that the edit endpoint then refused —
// rendering it permanently un-editable.
export const MAX_DESTINATIONS = 30;
// Per-day caps multiply, so cap the TOTALS too — these bound the SQL statement
// count regardless of how the per-day caps combine (defends D1 batch limits).
export const MAX_TOTAL_ENTRIES = 1000;
// POIs are find-or-created sequentially (1-2 D1 queries each), so cap lower to
// stay within the Worker subrequest budget. A real trip is well under this.
export const MAX_TOTAL_POIS = 400;

const POI_TYPES = ['hotel', 'restaurant', 'shopping', 'parking', 'attraction', 'transport', 'other'] as const;
const SEG_MODES = ['driving', 'walking', 'transit'] as const;
const SEG_SOURCES = ['google', 'manual', 'haversine', 'error'] as const;
const RESV_KINDS = ['restaurant', 'experience', 'ticket', 'transport', 'other'] as const;
const EMERGENCY_KINDS = ['personal', 'embassy', 'police', 'medical', 'insurance', 'hotel', 'other'] as const;
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/* ===== Normalized (safe) shape — only fields import will INSERT ===== */

export interface NImportPoi {
  sortOrder: number;
  name: string;
  type: string;
  category: string | null;
  lat: number | null;
  lng: number | null;
  hours: string | null;
  rating: number | null;
  price: string | null;
  address: string | null;
  placeId: string | null;
  reservation: string | null;
  reservationUrl: string | null;
  description: string | null;
  note: string | null;
}
export interface NImportEntry {
  sortOrder: number;
  startTime: string | null;
  endTime: string | null;
  description: string | null;
  note: string | null;
  source: string;
  pois: NImportPoi[];
  /** Position in the flattened trip-wide entry list (segment remap key). */
  entryPosition: number;
}
export interface NImportHotel {
  name: string; type: string; lat: number | null; lng: number | null;
  category: string | null; hours: string | null; rating: number | null;
  address: string | null; placeId: string | null; note: string | null;
}
export interface NImportDay {
  dayNum: number; date: string; dayOfWeek: string; label: string;
  entries: NImportEntry[];
  hotel: NImportHotel | null;
}
export interface NImportDest {
  name: string; lat: number | null; lng: number | null; dayQuota: number | null; subAreas: string[] | null;
}
export interface NImportSegment {
  fromEntryIdx: number; toEntryIdx: number; mode: string; submode: string | null; min: number | null; distanceM: number | null; source: string | null; noTravel: number | null;
}
export interface NImportNotes {
  flights: Record<string, string | number>[];
  lodgings: Record<string, string | number>[];
  reservations: Record<string, string | number>[];
  pretripNotes: Record<string, string | number>[];
  emergencyContacts: Record<string, string | number>[];
}
export interface NormalizedImport {
  name: string;
  title: string | null;
  description: string | null;
  countries: string | null;
  lang: string;
  days: NImportDay[];
  destinations: NImportDest[];
  segments: NImportSegment[];
  notes: NImportNotes;
}

export type ImportResult =
  | { ok: true; data: NormalizedImport }
  | { ok: false; error: string };

/* ===== coercion helpers (pure) ===== */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function str(v: unknown, max = 2000): string {
  if (v == null) return '';
  return String(v).slice(0, max);
}
/**
 * 淨化匯入的交通方式細分（submode，非 transit → null）。攻擊者控制 JSON → 去
 * 控制/雙向/零寬字元 + 20 字上限，行為對齊 segments/_shared.ts 的 sanitizeSubmode
 * （安全邊界刻意自含、不 import API 層；兩處須同步維護，sanitize-parity 契約有測鎖）。
 */
const IMPORT_MAX_SUBMODE_LEN = 20; // 對齊 segments/_shared.ts MAX_SUBMODE_LEN（自含，不 import）
function cleanSubmode(v: unknown, mode: string): string | null {
  if (mode !== 'transit' || typeof v !== 'string') return null;
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue;               // C0 + DEL
    if (c >= 0x80 && c <= 0x9f) continue;               // C1
    if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfeff || c === 0x2060) continue; // 零寬
    if (c >= 0x202a && c <= 0x202e) continue;           // bidi embedding/override
    if (c >= 0x2066 && c <= 0x2069) continue;           // bidi isolates
    if (c === 0x200e || c === 0x200f || c === 0x061c) continue; // 方向標記 LRM/RLM/ALM
    if (c === 0x2028 || c === 0x2029) continue;         // line/para sep
    out += ch;
  }
  const s = [...out.trim()].slice(0, IMPORT_MAX_SUBMODE_LEN).join('');
  return s.length > 0 ? s : null;
}
function strOrNull(v: unknown, max = 2000): string | null {
  if (v == null || v === '') return null;
  return String(v).slice(0, max);
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}
// v2.55.45: segment min 對齊互動端 isValidMin（1–1440）。攻擊者/髒匯入的超界值（如
// 2e9）會流進健檢「權威 block」當數字，故越界一律降為 null（視為未記錄），不整批 reject。
function segMinOrNull(v: unknown): number | null {
  const n = intOrNull(v);
  return n != null && n >= 1 && n <= 1440 ? n : null;
}
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const oneOfOrNull = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null);

/** Recursively reject any object carrying a prototype-pollution key (incl
 *  non-enumerable + symbol keys, belt-and-suspenders beyond JSON.parse). */
export function hasDangerousKey(v: unknown, depth = 0): boolean {
  if (depth > 12) return true; // pathological nesting → treat as hostile
  if (Array.isArray(v)) return v.some((x) => hasDangerousKey(x, depth + 1));
  if (isObj(v)) {
    for (const k of Object.getOwnPropertyNames(v)) {
      if (DANGEROUS_KEYS.includes(k)) return true;
      if (hasDangerousKey((v as Record<string, unknown>)[k], depth + 1)) return true;
    }
    for (const s of Object.getOwnPropertySymbols(v)) {
      if (hasDangerousKey((v as Record<symbol, unknown>)[s], depth + 1)) return true;
    }
  }
  return false;
}

/* ===== normalizers ===== */

function normPoi(raw: unknown): NImportPoi | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 200).trim();
  if (!name) return null; // pois.name is NOT NULL — skip nameless
  return {
    sortOrder: Math.max(1, intOrNull(raw.sortOrder) ?? 1),
    name,
    type: oneOf(raw.type, POI_TYPES, 'other'),
    category: strOrNull(raw.category, 100),
    lat: numOrNull(raw.lat),
    lng: numOrNull(raw.lng),
    hours: strOrNull(raw.hours, 500),
    rating: numOrNull(raw.rating ?? raw.googleRating),
    price: strOrNull(raw.price, 50),
    address: strOrNull(raw.address, 500),
    placeId: strOrNull(raw.placeId ?? raw.place_id, 200),
    // D 寫入防堵：匯入檔是 attacker-controlled JSON，被誤存成 JSON 的訂位狀態 → 人話文字。
    reservation: normalizeReservation(strOrNull(raw.reservation, 500)),
    reservationUrl: strOrNull(raw.reservationUrl, 500),
    description: strOrNull(raw.description, 2000),
    note: strOrNull(raw.note, 2000),
  };
}

function normEntry(raw: unknown, entryPosition: number): NImportEntry {
  const o = isObj(raw) ? raw : {};
  const rawPois = arr(o.stopPois).slice(0, MAX_POIS_PER_ENTRY).map(normPoi).filter((p): p is NImportPoi => p !== null);
  // Preserve master-first order, then RENUMBER sort_order to 1..N so the
  // trip_entry_pois UNIQUE(entry_id, sort_order) constraint can't be violated by
  // duplicate / gappy sort_order in an untrusted payload.
  rawPois.sort((a, b) => a.sortOrder - b.sortOrder);
  const pois = rawPois.map((p, i) => ({ ...p, sortOrder: i + 1 }));
  const master = pois[0];

  // migration 0078: entry-level note 已從 trip_entries DROP，round-trip 的「整體備註」
  // 改掛 master（sort_order=1）POI 的 per-POI note。新匯出檔 entry 不再帶 top-level note；
  // 但舊匯出檔仍可能帶 `entryNote` —— 為不遺失資料，fold 到 master POI。
  // 合併語意：**master-wins**（master 自己有 note → 保留，不被 entry note 覆蓋；master 為空 →
  // 繼承 entry note）。與 import.ts orchestration 的 `p.note ?? e.note` 一致（import 是建立全新
  // 行程，非既有資料 backfill，故採 master 優先而非 migration D5 的換行串接）。備選（sort_order>1）
  // 維持各自 note，entry note 不外洩。entry 完全沒有 POI → entry note 無處可掛而丟棄（罕見純佔位 entry）。
  const entryNote = strOrNull(o.note, 4000);
  if (entryNote && master) {
    master.note = master.note ?? entryNote;
  }

  return {
    sortOrder: intOrNull(o.sortOrder) ?? entryPosition,
    startTime: strOrNull(o.startTime, 20),
    endTime: strOrNull(o.endTime, 20),
    description: strOrNull(o.description, 4000),
    // 保留原始 entry-level note 供向後相容（import.ts orchestration 的 `p.note ?? e.note`
    // fallback 仍引用此欄）；實際 master 已於上方 fold，故 orchestration fallback 不會重複寫入。
    note: entryNote,
    source: str(o.source, 30) || 'imported',
    pois,
    entryPosition,
  };
}

function normHotel(raw: unknown): NImportHotel | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 200).trim();
  if (!name) return null;
  return {
    name,
    type: 'hotel',
    lat: numOrNull(raw.lat),
    lng: numOrNull(raw.lng),
    category: strOrNull(raw.category, 100),
    hours: strOrNull(raw.hours, 500),
    rating: numOrNull(raw.rating ?? raw.googleRating),
    address: strOrNull(raw.address, 500),
    placeId: strOrNull(raw.placeId ?? raw.place_id, 200),
    note: strOrNull(raw.note, 2000),
  };
}

/**
 * Validate + normalize an import payload. Returns the safe shape or an error.
 * `pos` (the flattened entry index) is assigned here so segments can remap.
 */
export function parseAndValidateImport(raw: unknown): ImportResult {
  if (!isObj(raw)) return { ok: false, error: '匯入內容必須是 JSON 物件' };
  if (raw.schemaVersion !== 1) return { ok: false, error: '不支援的匯出格式版本（需 schemaVersion 1）' };
  if (hasDangerousKey(raw)) return { ok: false, error: '匯入內容含不允許的欄位' };

  const rawDays = arr(raw.days);
  for (const field of ['weather', 'weather_json'] as const) {
    const hasLegacyField = Object.prototype.hasOwnProperty.call(raw, field)
      || rawDays.some((day) => isObj(day) && Object.prototype.hasOwnProperty.call(day, field));
    if (hasLegacyField) return { ok: false, error: `${field} 已移除` };
  }
  if (rawDays.length > MAX_DAYS) return { ok: false, error: `天數超過上限（${MAX_DAYS}）` };
  if (arr(raw.segments).length > MAX_SEGMENTS) return { ok: false, error: `交通段超過上限（${MAX_SEGMENTS}）` };

  const meta = isObj(raw.meta) ? raw.meta : {};
  const metaName = str(meta.name, 200).trim() || str(meta.title, 200).trim();
  if (!metaName) return { ok: false, error: '行程缺少名稱' };

  let pos = 0;
  const days: NImportDay[] = [];
  for (let i = 0; i < rawDays.length; i++) {
    const d = isObj(rawDays[i]) ? (rawDays[i] as Record<string, unknown>) : {};
    const rawTimeline = arr(d.timeline);
    if (rawTimeline.length > MAX_ENTRIES_PER_DAY) {
      return { ok: false, error: `Day ${i + 1} 景點數超過上限（${MAX_ENTRIES_PER_DAY}）` };
    }
    const entries = rawTimeline.map((e) => normEntry(e, pos++));
    days.push({
      dayNum: intOrNull(d.dayNum) ?? i + 1,
      date: str(d.date, 20),
      dayOfWeek: str(d.dayOfWeek, 20),
      label: str(d.label, 200),
      entries,
      hotel: normHotel(d.hotel),
    });
  }
  const totalEntries = pos;
  if (totalEntries > MAX_TOTAL_ENTRIES) return { ok: false, error: `景點總數超過上限（${MAX_TOTAL_ENTRIES}）` };
  let totalPois = 0;
  for (const d of days) for (const e of d.entries) totalPois += e.pois.length;
  if (totalPois > MAX_TOTAL_POIS) return { ok: false, error: `POI 總數超過上限（${MAX_TOTAL_POIS}）` };

  const destinations: NImportDest[] = arr(meta.destinations).slice(0, MAX_DESTINATIONS).map((dd) => {
    const o = isObj(dd) ? dd : {};
    const subAreas = arr(o.subAreas).map((s) => str(s, 100)).filter(Boolean);
    return {
      name: str(o.name, 200),
      lat: numOrNull(o.lat),
      lng: numOrNull(o.lng),
      dayQuota: intOrNull(o.dayQuota),
      subAreas: subAreas.length ? subAreas : null,
    };
  }).filter((dd) => dd.name);

  // segments — drop any whose positional idx is out of range (defensive; export
  // already filters orphans, but the payload is untrusted).
  const segments: NImportSegment[] = arr(raw.segments).map((s) => {
    const o = isObj(s) ? s : {};
    const noTravel = o.noTravel === 1 || o.noTravel === true ? 1 : null;
    return {
      fromEntryIdx: intOrNull(o.fromEntryIdx) ?? -1,
      toEntryIdx: intOrNull(o.toEntryIdx) ?? -1,
      mode: oneOf(o.mode, SEG_MODES, 'driving'),
      submode: cleanSubmode(o.submode, oneOf(o.mode, SEG_MODES, 'driving')),
      // no_travel=1 ⟹ min/dist/source 一律 NULL（同 POST/PATCH 不變式）。untrusted payload
      // 可能帶 noTravel=1 又塞 min/source=manual → recompute 永久跳過 + 髒值餵健檢，此處清乾淨。
      min: noTravel ? null : segMinOrNull(o.min),
      distanceM: noTravel ? null : intOrNull(o.distanceM),
      source: noTravel ? null : oneOfOrNull(o.source, SEG_SOURCES),
      noTravel,
    };
  }).filter((s) =>
    s.fromEntryIdx >= 0 && s.fromEntryIdx < totalEntries &&
    s.toEntryIdx >= 0 && s.toEntryIdx < totalEntries &&
    s.fromEntryIdx !== s.toEntryIdx,
  );
  // Dedupe (from,to) pairs — trip_segments has UNIQUE(from_entry_id, to_entry_id);
  // a duplicated pair in the payload would otherwise fail the INSERT.
  const seenSeg = new Set<string>();
  const dedupedSegments = segments.filter((s) => {
    const k = `${s.fromEntryIdx}-${s.toEntryIdx}`;
    if (seenSeg.has(k)) return false;
    seenSeg.add(k);
    return true;
  });

  const rawNotes = isObj(raw.notes) ? raw.notes : {};
  const capNotes = (v: unknown) => arr(v).slice(0, MAX_NOTES_PER_SECTION);
  const notes: NImportNotes = {
    flights: capNotes(rawNotes.flights).map((r, i) => ({
      sort_order: i,
      ...camelNoteRow(r, { airline: 'airline', flightNo: 'flight_no', cabinClass: 'cabin_class', departAirport: 'depart_airport', arriveAirport: 'arrive_airport', departAt: 'depart_at', arriveAt: 'arrive_at', note: 'note' }),
    })),
    lodgings: capNotes(rawNotes.lodgings).map((r, i) => ({
      sort_order: i,
      ...camelNoteRow(r, { name: 'name', address: 'address', checkInAt: 'check_in_at', checkOutAt: 'check_out_at', bookingNo: 'booking_no', phone: 'phone', note: 'note' }),
    })),
    reservations: capNotes(rawNotes.reservations).map((r, i) => {
      const o = isObj(r) ? r : {};
      return {
        sort_order: i,
        kind: oneOf(o.kind, RESV_KINDS, 'restaurant'),
        party_size: intOrNull(o.partySize) ?? 0,
        ...camelNoteRow(r, { title: 'title', reservedAt: 'reserved_at', reservationNo: 'reservation_no', phone: 'phone', note: 'note' }),
      };
    }),
    pretripNotes: capNotes(rawNotes.pretripNotes).map((r, i) => ({
      sort_order: i,
      ...camelNoteRow(r, { section: 'section', title: 'title', content: 'content' }),
    })),
    emergencyContacts: capNotes(rawNotes.emergencyContacts).map((r, i) => {
      const o = isObj(r) ? r : {};
      return {
        sort_order: i,
        kind: oneOf(o.kind, EMERGENCY_KINDS, 'other'), // CHECK constraint
        ...camelNoteRow(r, { name: 'name', relationship: 'relationship', phone: 'phone', email: 'email' }),
      };
    }),
  };

  return {
    ok: true,
    data: {
      name: metaName,
      title: strOrNull(meta.title, 200),
      description: strOrNull(meta.description, 4000),
      countries: strOrNull(meta.countries, 200),
      lang: oneOf(meta.lang, ['zh-TW', 'en', 'ja'] as const, 'zh-TW'),
      days,
      destinations,
      segments: dedupedSegments,
      notes,
    },
  };
}

/** Map camelCase source keys → snake_case columns, string-clamped. */
function camelNoteRow(raw: unknown, map: Record<string, string>): Record<string, string> {
  const o = isObj(raw) ? raw : {};
  const out: Record<string, string> = {};
  for (const [camel, snake] of Object.entries(map)) out[snake] = str(o[camel], 2000);
  return out;
}
