/**
 * 單一 POI resolver（#1256 合併舊 resolvePoi 與 findOrCreatePoi）。
 * Race-safe: INSERT OR IGNORE + re-fetch with UNIQUE(name, type) index.
 * 找到既有 row 時的行為由 policy 決定（見 ResolvePoiOptions），不再靠選函式。
 */
import { AppError } from '../errors';
import { normalizePoiAddress } from './maps/normalize-address';

const POI_TYPE_WHITELIST = [
  'hotel',
  'restaurant',
  'shopping',
  'parking',
  'attraction',
  'transport',
  'activity',
  'other',
] as const;

export type PoiType = (typeof POI_TYPE_WHITELIST)[number];

const POI_TYPE_SET = new Set<string>(POI_TYPE_WHITELIST);

export function normalizePoiType(raw: unknown, fallback: PoiType = 'attraction'): PoiType {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') {
    throw new AppError('DATA_VALIDATION', 'type 必須是字串');
  }
  const type = raw.trim().toLowerCase();
  if (type === '') return fallback;
  if (!POI_TYPE_SET.has(type)) {
    throw new AppError('DATA_VALIDATION', `不支援的 POI type: ${raw}`);
  }
  return type as PoiType;
}

function normalizeOptionalString(raw: unknown, field: string): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new AppError('DATA_VALIDATION', `${field} 必須是字串`);
  }
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function normalizeCoordinate(raw: unknown, field: 'lat' | 'lng'): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new AppError('DATA_VALIDATION', `${field} 必須是數字`);
  }
  const min = field === 'lat' ? -90 : -180;
  const max = field === 'lat' ? 90 : 180;
  if (raw < min || raw > max) {
    throw new AppError('DATA_VALIDATION', `${field} 超出有效範圍`);
  }
  return raw;
}

function normalizeOptionalRating(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new AppError('DATA_VALIDATION', 'rating 必須是數字');
  }
  return raw;
}

export interface FindOrCreatePoiData {
  name: string;
  type: string;
  description?: string | null;
  // Migration 0045: dropped `maps` (replaced by mapsUrl helper, commit 13)
  // Migration 0066 (v2.30.15): dropped `mapcode` — Google/Apple Map link 已涵蓋導航需求
  lat?: number | null;
  lng?: number | null;
  // Migration 0045: renamed google_rating → rating (1-7 OpenTripMap, was 1-5 Google)
  rating?: number | null;
  category?: string | null;
  hours?: string | null;
  source?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  country?: string | null;
  // Migration 0054 (v2.25.4): price 從 trip_pois 移到 pois master
  price?: string | null;
  // v2.23.0: Google Places place_id — stored so POST /pois/:id/enrich works
  // immediately (else the POI waits for the 30-day place_id backfill).
  place_id?: string | null;
  // Migration 0051: lifecycle 欄位。一般「建新 POI」的 caller 不帶這些 → INSERT
  // 用 column 預設（status='active'、其餘 NULL）。只有 re-point「換分類複製整筆」
  // 時帶進來，讓 closed/missing 的真實地點換分類後仍保留歇業狀態（不被重設 active）。
  // 刻意不進 COALESCE_FIELDS：撞既有同名同類 row（merge）時，那筆是另一個真實
  // 地點、自有 lifecycle，不可被來源狀態覆寫。
  status?: string | null;
  status_reason?: string | null;
  status_checked_at?: string | null;
}

export interface FindOrCreatePoiPayload {
  name?: unknown;
  type?: unknown;
  lat?: unknown;
  lng?: unknown;
  rating?: unknown;
  category?: unknown;
  address?: unknown;
  country?: unknown;
  source?: unknown;
  place_id?: unknown;
}

export function normalizeFindOrCreatePoiPayload(raw: FindOrCreatePoiPayload): FindOrCreatePoiData {
  const name = normalizeOptionalString(raw.name, 'name');
  if (!name) throw new AppError('DATA_VALIDATION', 'name 必須是非空字串');

  return {
    name,
    type: normalizePoiType(raw.type),
    lat: normalizeCoordinate(raw.lat, 'lat'),
    lng: normalizeCoordinate(raw.lng, 'lng'),
    rating: normalizeOptionalRating(raw.rating),
    category: normalizeOptionalString(raw.category, 'category'),
    // v2.31.36: address 經 normalizePoiAddress 清「號號」/「縣縣」等 typo doubled。
    address: normalizePoiAddress(normalizeOptionalString(raw.address, 'address')),
    country: normalizeOptionalString(raw.country, 'country'),
    source: normalizeOptionalString(raw.source, 'source') ?? 'google',
    place_id: normalizeOptionalString(raw.place_id, 'place_id'),
  };
}

/**
 * 既有 POI 撞到時怎麼辦 —— ADR-0001 的 immutable master 由這個參數守門。
 *   keep      ：任何欄位不改。目前沒有呼叫端（匯入／clone 於 2026-09-05 owner 拍板改走
 *               fill-null），留給日後「絕不動 master」的路徑。
 *   fill-null ：只 COALESCE 補 NULL 欄，非 NULL 值不覆蓋（所有現行路徑）。
 * createdPoiIds：只記「本次新建」的 id，供失敗時 rollback；既有 row 不記。
 */
export interface ResolvePoiOptions {
  policy: 'keep' | 'fill-null';
  createdPoiIds?: number[];
  /**
   * 新建 row 時 country 未給／null 的預設。預設 'JP'（既有 UI 路徑慣例）；匯入／clone 傳 null
   * 表示不猜國家。只影響 INSERT，不影響 fill-null 的 COALESCE（null 一律跳過、不會把既有
   * NULL country 補成預設值）。
   */
  defaultCountry?: string | null;
}

const COALESCE_FIELDS = [
  'description', 'lat', 'lng', 'rating',
  'category', 'hours', 'address', 'phone', 'email', 'website', 'country',
  'price', 'place_id',
] as const;

type CoalesceField = typeof COALESCE_FIELDS[number];

function buildCoalesceUpdate(data: FindOrCreatePoiData): { fills: string[]; vals: unknown[] } {
  const fills: string[] = [];
  const vals: unknown[] = [];
  for (const col of COALESCE_FIELDS) {
    const val = data[col as CoalesceField];
    if (val != null) {
      fills.push(`${col} = COALESCE(${col}, ?)`);
      vals.push(val);
    }
  }
  return { fills, vals };
}

const INSERT_POI_SQL =
  'INSERT OR IGNORE INTO pois (type, name, description, hours, rating, category, lat, lng, source, address, phone, email, website, country, price, place_id, status, status_reason, status_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id';

function bindInsertPoi(db: D1Database, data: FindOrCreatePoiData, defaultCountry: string | null): D1PreparedStatement {
  // Migration 0045: dropped maps col. 0054: price. 0051: lifecycle 三欄（一般 caller 不帶 → 預設）。
  return db.prepare(INSERT_POI_SQL).bind(
    data.type, data.name, data.description ?? null, data.hours ?? null,
    data.rating ?? null, data.category ?? null,
    data.lat ?? null, data.lng ?? null, data.source ?? 'ai',
    data.address ?? null, data.phone ?? null, data.email ?? null,
    data.website ?? null, data.country ?? defaultCountry, data.price ?? null,
    data.place_id ?? null,
    data.status ?? 'active', data.status_reason ?? null, data.status_checked_at ?? null,
  );
}

export async function findOrCreatePoi(
  db: D1Database,
  data: FindOrCreatePoiData,
  opts: ResolvePoiOptions,
): Promise<number> {
  // Try exact match first (dedup key = name + type)
  const existing = await db.prepare(
    'SELECT id FROM pois WHERE name = ? AND type = ? LIMIT 1'
  ).bind(data.name, data.type).first<{ id: number }>();

  if (existing) {
    if (opts.policy === 'keep') return existing.id;
    // fill-null: only fill NULL fields, never overwrite existing values
    const { fills, vals } = buildCoalesceUpdate(data);
    if (fills.length > 0) {
      await db.prepare(`UPDATE pois SET ${fills.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .bind(...vals, existing.id).run();
    }
    return existing.id;
  }

  // Not found → INSERT (INSERT OR IGNORE for race-safety with UNIQUE index)
  const result = await bindInsertPoi(db, data, opts.defaultCountry === undefined ? 'JP' : opts.defaultCountry).first<{ id: number }>();

  // INSERT OR IGNORE returns null if concurrent insert won the race
  if (result) { opts.createdPoiIds?.push(result.id); return result.id; }

  const reFetch = await db.prepare(
    'SELECT id FROM pois WHERE name = ? AND type = ? LIMIT 1'
  ).bind(data.name, data.type).first<{ id: number }>();
  if (!reFetch) throw new AppError('SYS_DB_ERROR', 'POI lost after INSERT OR IGNORE');
  return reFetch.id;
}

/**
 * Batch find-or-create multiple POIs in 2–3 DB round-trips instead of N.
 * Returns an array of poi IDs in the same order as the input.
 */
export async function batchFindOrCreatePois(
  db: D1Database,
  items: FindOrCreatePoiData[],
  opts: ResolvePoiOptions,
): Promise<number[]> {
  if (items.length === 0) return [];

  // Deduplicate by (name, type) — same POI may appear multiple times
  const keyOf = (d: FindOrCreatePoiData) => `${d.type}\0${d.name}`;
  const uniqueMap = new Map<string, { data: FindOrCreatePoiData; poiId?: number }>();
  for (const item of items) {
    const key = keyOf(item);
    if (!uniqueMap.has(key)) uniqueMap.set(key, { data: item });
  }
  const uniqueItems = [...uniqueMap.values()];

  // Step 1: Batch SELECT all existing POIs
  const selectStmts = uniqueItems.map(({ data }) =>
    db.prepare('SELECT id FROM pois WHERE name = ? AND type = ? LIMIT 1').bind(data.name, data.type)
  );
  const selectResults = await db.batch(selectStmts);

  // Separate found vs. missing
  const toUpdate: { idx: number; id: number }[] = [];
  const toInsert: number[] = [];
  for (let i = 0; i < uniqueItems.length; i++) {
    const rows = selectResults[i]!.results as { id: number }[];
    if (rows.length > 0) {
      uniqueItems[i]!.poiId = rows[0]!.id;
      toUpdate.push({ idx: i, id: rows[0]!.id });
    } else {
      toInsert.push(i);
    }
  }

  // Step 2: Batch COALESCE updates for existing POIs（policy=keep 時跳過）
  if (opts.policy === 'fill-null' && toUpdate.length > 0) {
    const updateStmts: D1PreparedStatement[] = [];
    for (const { idx, id } of toUpdate) {
      const { fills, vals } = buildCoalesceUpdate(uniqueItems[idx]!.data);
      if (fills.length > 0) {
        updateStmts.push(
          db.prepare(`UPDATE pois SET ${fills.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .bind(...vals, id)
        );
      }
    }
    if (updateStmts.length > 0) await db.batch(updateStmts);
  }

  // Step 3: Batch INSERT OR IGNORE for missing POIs
  if (toInsert.length > 0) {
    const insertStmts = toInsert.map((idx) => bindInsertPoi(db, uniqueItems[idx]!.data, opts.defaultCountry === undefined ? 'JP' : opts.defaultCountry));
    const insertResults = await db.batch(insertStmts);

    // Collect IDs; race-collisions (INSERT OR IGNORE) return empty results
    const reFetchIndices: number[] = [];
    for (let i = 0; i < toInsert.length; i++) {
      const rows = insertResults[i]!.results as { id: number }[];
      if (rows.length > 0) {
        uniqueItems[toInsert[i]!]!.poiId = rows[0]!.id;
        opts.createdPoiIds?.push(rows[0]!.id);
      } else {
        reFetchIndices.push(toInsert[i]!);
      }
    }

    // Step 4: Re-fetch any race-collision rows
    if (reFetchIndices.length > 0) {
      const reFetchStmts = reFetchIndices.map((idx) => {
        const data = uniqueItems[idx]!.data;
        return db.prepare('SELECT id FROM pois WHERE name = ? AND type = ? LIMIT 1')
          .bind(data.name, data.type);
      });
      const reFetchResults = await db.batch(reFetchStmts);
      for (let i = 0; i < reFetchIndices.length; i++) {
        const rows = reFetchResults[i]!.results as { id: number }[];
        const refetched = rows[0];
        if (!refetched) throw new AppError('SYS_DB_ERROR', 'POI lost after race-collision re-fetch');
        uniqueItems[reFetchIndices[i]!]!.poiId = refetched.id;
      }
    }
  }

  // Map back: input order → poiId
  return items.map((item) => {
    const entry = uniqueMap.get(keyOf(item));
    if (!entry?.poiId) throw new AppError('SYS_DB_ERROR', 'POI ID missing after batch upsert');
    return entry.poiId;
  });
}
