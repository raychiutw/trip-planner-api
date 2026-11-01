/**
 * Shared helpers for the public trip-share platform (v2.39.0).
 *
 * Design: ~/.gstack/projects/raychiutw-trip-planner/ray-master-design-20260530-191308.md
 *
 * Security load-bearing wall (design §安全設計):
 *  - Tokens are stored as SHA-256 hashes only (raw token never hits the DB).
 *  - `loadVisibleShareData` is the SINGLE source of the public payload, consumed by
 *    both GET /api/share/:token and (PR3) the clone path. Section filtering is
 *    DEFAULT-DENY: a closed note section's table is never SELECTed — the payload is
 *    built from an allowlist, never fetched-then-stripped.
 *  - The trip body (days/timeline/POIs) is always public; only the 5 note sections
 *    are gated. The payload carries NO owner PII (no email/user_id).
 */
import { buildAllDays } from './day-merge';
import { generateOpaqueToken } from './utils';

/** Canonical note-section keys (match PrintNotes / mapNotes on the client). */
export const SHARE_SECTIONS = ['flights', 'lodgings', 'reservations', 'pretrip', 'emergency'] as const;
export type ShareSection = (typeof SHARE_SECTIONS)[number];

/** Safe default on create: itinerary always public; 預訂 + 緊急聯絡 default OFF. */
export const DEFAULT_SHARE_SECTIONS: ShareSection[] = ['flights', 'lodgings', 'pretrip'];

/** Token = 24 random bytes → 32-char URL-safe base64 (no padding) ≈ 192 bits. */
const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** Cheap pre-filter against junk-scanning before any DB / crypto work. */
export function isValidShareToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** CSPRNG token (caller stores only its hash). */
export function generateShareToken(): string {
  return generateOpaqueToken(TOKEN_BYTES);
}

/** SHA-256 hex — the only token form that ever touches the DB. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Allowlist parse: only known section keys survive (default-deny unknown/garbage). */
export function parseVisibleSections(json: string | null | undefined): ShareSection[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return SHARE_SECTIONS.filter((s) => raw.includes(s));
}

/** Normalise owner-supplied section input to the allowlist before persisting. */
export function sanitizeVisibleSections(input: unknown): ShareSection[] {
  const a = Array.isArray(input) ? input : [];
  return SHARE_SECTIONS.filter((s) => a.includes(s));
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Owner-supplied expires_at (epoch ms): must be a future time within 1 year, else
 * null (= never). Bounds the horizon + rejects past/garbage. `nowMs` is injectable
 * for deterministic tests (Date.now() is unavailable in some sandboxes).
 */
export function validateExpiresAt(input: unknown, nowMs: number = Date.now()): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  if (input <= nowMs || input > nowMs + ONE_YEAR_MS) return null;
  return Math.floor(input);
}

export interface ShareRow {
  id: number;
  trip_id: string;
  token_hash: string;
  label: string;
  visible_sections: string;
  expires_at: number | null;
  view_count: number;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  anonymous: number;
}

/** Public payload shape — mapped client-side by mapRawToPrintData. NO owner PII. */
export interface VisibleSharePayload {
  meta: {
    name: string;
    title: string | null;
    countries: string | null;
    /** Owner display_name ONLY (decision #8「分享即視為同意露名」); never email/user_id. */
    sharedBy: string;
    destinations: { name: string }[];
  };
  days: Record<string, unknown>[];
  notes: {
    flights: unknown[];
    lodgings: unknown[];
    reservations: unknown[];
    pretripNotes: unknown[];
    emergencyContacts: unknown[];
  };
}

/**
 * Resolve a raw token → active share row, or null. One query + state checks so
 * not-found / revoked / expired are indistinguishable (no enumeration oracle).
 * Format-prechecks before hashing to avoid DB hits on obvious junk.
 */
export async function resolveActiveShare(db: D1Database, token: string): Promise<ShareRow | null> {
  if (!isValidShareToken(token)) return null;
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare('SELECT * FROM trip_shares WHERE token_hash = ?')
    .bind(tokenHash)
    .first<ShareRow>();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at != null && row.expires_at < Date.now()) return null;
  return row;
}

async function buildShareMeta(
  db: D1Database,
  tripId: string,
  anonymous: boolean,
): Promise<VisibleSharePayload['meta']> {
  const [trip, dests] = await Promise.all([
    // Allowlist SELECT — only name/title/countries + owner display_name. The owner's
    // user_id / email are NEVER selected into the public payload (design S9).
    db
      .prepare(
        `SELECT t.name, t.title, t.countries, u.display_name AS shared_by
         FROM trips t LEFT JOIN users u ON u.id = t.owner_user_id
         WHERE t.id = ?`,
      )
      .bind(tripId)
      .first<{ name: string | null; title: string | null; countries: string | null; shared_by: string | null }>(),
    db
      .prepare('SELECT name FROM trip_destinations WHERE trip_id = ? ORDER BY dest_order ASC')
      .bind(tripId)
      .all<{ name: string }>(),
  ]);
  return {
    name: trip?.name ?? '',
    title: trip?.title ?? null,
    countries: trip?.countries ?? null,
    // anonymous link → never expose the owner's name in the public payload.
    sharedBy: anonymous ? '' : (trip?.shared_by ?? ''),
    destinations: (dests.results ?? []).map((d) => ({ name: d.name })),
  };
}

/**
 * DEFAULT-DENY note builder: a section's SELECT runs ONLY when its key is in the
 * allowlist. Closed sections are never queried → their rows never enter the payload.
 */
async function buildVisibleNotes(
  db: D1Database,
  tripId: string,
  visible: ShareSection[],
): Promise<VisibleSharePayload['notes']> {
  const sel = (table: string) =>
    db.prepare(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY sort_order ASC, id ASC`).bind(tripId).all();
  const on = (s: ShareSection) => visible.includes(s);

  const [flights, lodgings, reservations, pretrip, emergency] = await Promise.all([
    on('flights') ? sel('trip_flights') : Promise.resolve(null),
    on('lodgings') ? sel('trip_lodgings') : Promise.resolve(null),
    on('reservations') ? sel('trip_reservations') : Promise.resolve(null),
    on('pretrip') ? sel('trip_pretrip_notes') : Promise.resolve(null),
    on('emergency') ? sel('trip_emergency_contacts') : Promise.resolve(null),
  ]);

  return {
    flights: flights?.results ?? [],
    lodgings: lodgings?.results ?? [],
    reservations: reservations?.results ?? [],
    pretripNotes: pretrip?.results ?? [],
    emergencyContacts: emergency?.results ?? [],
  };
}

/**
 * The single filtered source of truth. Builds the public payload from an active
 * share row: always-public trip body (reusing buildAllDays — byte-identical to the
 * authed view) + ONLY the share's visible note sections. Used by the public GET
 * and (PR3) the clone path so private sections can never leak via either door.
 */
export async function loadVisibleShareData(db: D1Database, share: ShareRow): Promise<VisibleSharePayload> {
  const visible = parseVisibleSections(share.visible_sections);
  const [meta, days, notes] = await Promise.all([
    buildShareMeta(db, share.trip_id, share.anonymous === 1),
    buildAllDays(db, share.trip_id),
    buildVisibleNotes(db, share.trip_id, visible),
  ]);
  return { meta, days, notes };
}
