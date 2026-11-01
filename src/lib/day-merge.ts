/**
 * 共用的 Day 組裝邏輯（單天 GET 與 batch GET 共用）
 *
 * v2.29.0: trip_pois 整表 DROPPED。
 *  - Hotel ← trip_days.hotel_poi_id (FK to pois)
 *  - Hotel parking ← poi_relations(relation_type='parking')
 *  - Entry POIs (master + alternates，含 ex-shopping) ← trip_entry_pois
 *  - travel object ← trip_segments (lookup by from_entry_id)
 *  - entry.shopping array DEPRECATED — shopping POI = alternates (frontend filter by type)
 */

type EntryPoiBucket = {
  master: Record<string, unknown> | null;
  alternates: Record<string, unknown>[];
  stopPois: Record<string, unknown>[];
  version: string;
};

type SegmentRow = {
  from_entry_id: number;
  to_entry_id: number;
  mode: string;
  submode: string | null;
  min: number | null;
  distance_m: number | null;
  source: string | null;
  computed_at: number | null;
  updated_at: number | null;
  /** v2.55.46: 1 = 同一地點/免交通 → travel 吐 sameplace marker、收合此段。 */
  no_travel: number | null;
};

/**
 * 從 trip_segments 取 trip-scope 的 segments，建 from_entry_id → segment 查找表。
 * 用於 assembleDay 將 travel response surface 到 timeline[i]。
 */
export async function fetchTripSegmentsMap(
  db: D1Database,
  tripId: string,
): Promise<Map<number, SegmentRow>> {
  const map = new Map<number, SegmentRow>();
  const { results } = await db
    .prepare(
      `SELECT from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at, no_travel
       FROM trip_segments WHERE trip_id = ?`,
    )
    .bind(tripId)
    .all<SegmentRow>();
  for (const r of results) {
    map.set(r.from_entry_id, r);
  }
  return map;
}

/**
 * 抓 hotel pois + parking relations 一起 map。
 *
 * @param db D1
 * @param hotelPoiIds 該 trip 所有 day 的 hotel_poi_id (deduped, non-null)
 * @returns
 *   - poiMap: Map<poi_id, pois row>（hotel + parking POI 都進來）
 *   - parkingMap: Map<hotelPoiId, parking poi[]>（hotel POI 對應的 parking 列表）
 */
export async function fetchHotelAndParking(
  db: D1Database,
  hotelPoiIds: number[],
): Promise<{
  poiMap: Map<number, Record<string, unknown>>;
  parkingMap: Map<number, Record<string, unknown>[]>;
}> {
  const poiMap = new Map<number, Record<string, unknown>>();
  const parkingMap = new Map<number, Record<string, unknown>[]>();

  if (hotelPoiIds.length === 0) return { poiMap, parkingMap };

  const placeholders = hotelPoiIds.map(() => '?').join(',');

  // 1. Hotel POI 主表
  // 2. poi_relations parking links
  // 3. 解 parking POI 主表
  const [hotelsRes, relationsRes] = await Promise.all([
    db.prepare(`SELECT * FROM pois WHERE id IN (${placeholders})`).bind(...hotelPoiIds).all(),
    db
      .prepare(
        `SELECT poi_id, related_poi_id FROM poi_relations
         WHERE relation_type = 'parking' AND poi_id IN (${placeholders})`,
      )
      .bind(...hotelPoiIds)
      .all<{ poi_id: number; related_poi_id: number }>(),
  ]);

  for (const p of hotelsRes.results as Record<string, unknown>[]) {
    poiMap.set(p.id as number, p);
  }

  // Fetch parking POI master rows
  const parkingIds = [...new Set(relationsRes.results.map((r) => r.related_poi_id))];
  if (parkingIds.length > 0) {
    const parkingPh = parkingIds.map(() => '?').join(',');
    const parkingRes = await db
      .prepare(`SELECT * FROM pois WHERE id IN (${parkingPh})`)
      .bind(...parkingIds)
      .all();
    for (const p of parkingRes.results as Record<string, unknown>[]) {
      poiMap.set(p.id as number, p);
    }
  }

  // Build parking map: hotelPoiId → [parking POI]
  for (const r of relationsRes.results) {
    const parkingPoi = poiMap.get(r.related_poi_id);
    if (!parkingPoi) continue;
    if (!parkingMap.has(r.poi_id)) parkingMap.set(r.poi_id, []);
    parkingMap.get(r.poi_id)!.push(parkingPoi);
  }

  return { poiMap, parkingMap };
}

/**
 * v2.27.0 multi-POI per entry：fetch trip_entry_pois rows for given entry IDs，
 * group by entry_id 並 JOIN pois 取 spatial fields。
 *
 * @param db D1 instance
 * @param entryIds 要查的 trip_entries.id list
 * @returns Map<entryId, { master, alternates, version }>。Entry 無 master row → master=null。
 */
export async function fetchEntryPoisByEntries(
  db: D1Database,
  entryIds: number[],
): Promise<Map<number, EntryPoiBucket>> {
  const result = new Map<number, EntryPoiBucket>();
  if (entryIds.length === 0) return result;

  const placeholders = entryIds.map(() => '?').join(',');

  // round 5 fix: read OCC version from trip_entries.entry_pois_version (dedicated counter,
  // migration 0058). Pre-fix, this function derived version from MAX(trip_entry_pois.updated_at)
  // while the write path validated trip_entries.updated_at — a fresh GET sent back a token
  // that the mutation path rejected as stale. Both paths now read the same integer counter.
  //
  // v2.29.0：timeline + shopping trip_pois rows migrated into trip_entry_pois by
  // migrations 0059 / 0061. Runtime reads canonical rows only.
  const [poisQuery, versionsQuery] = await Promise.all([
    db
      .prepare(
        `SELECT tep.entry_id, tep.poi_id, tep.sort_order, tep.updated_at,
                p.name, p.lat, p.lng, p.type, p.category,
                p.hours, p.rating, p.price, p.source,
                tep.reservation, tep.reservation_url, tep.description, tep.note
         FROM trip_entry_pois tep
         JOIN pois p ON p.id = tep.poi_id
         WHERE tep.entry_id IN (${placeholders})
         ORDER BY tep.entry_id, tep.sort_order`,
      )
      .bind(...entryIds)
      .all<{
        entry_id: number;
        poi_id: number;
        sort_order: number;
        updated_at: string;
        name: string | null;
        lat: number | null;
        lng: number | null;
        type: string | null;
        category: string | null;
        hours: string | null;
        rating: number | null;
        price: string | null;
        source: string | null;
        reservation: string | null;
        reservation_url: string | null;
        description: string | null;
        note: string | null;
      }>(),
    db
      .prepare(`SELECT id, entry_pois_version FROM trip_entries WHERE id IN (${placeholders})`)
      .bind(...entryIds)
      .all<{ id: number; entry_pois_version: number }>(),
  ]);

  // Seed buckets with versions (so entries with no trip_entry_pois rows still get a version)
  for (const v of versionsQuery.results) {
    result.set(v.id, { master: null, alternates: [], stopPois: [], version: String(v.entry_pois_version) });
  }

  for (const r of poisQuery.results) {
    const bucket = result.get(r.entry_id);
    if (!bucket) continue; // orphan trip_entry_pois row (FK inconsistency); skip
    const poiInfo: Record<string, unknown> = {
      poi_id: r.poi_id,
      sort_order: r.sort_order,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      type: r.type,
      category: r.category,
      source: r.source,
      hours: r.hours,
      rating: r.rating,
      price: r.price,
      reservation: r.reservation,
      reservation_url: r.reservation_url,
      description: r.description,
      note: r.note,
    };
    bucket.stopPois.push(poiInfo);
    if (r.sort_order === 1) {
      bucket.master = poiInfo;
    } else {
      bucket.alternates.push({ ...poiInfo, sort_order: r.sort_order });
    }
  }

  return result;
}

/**
 * 組裝單天完整資料：hotel + timeline (含 travel from segments + multi-POI from entry_pois)。
 *
 * **前置條件**：`entries` 必須已依 `sort_order ASC` 排序（caller 負責）。
 * 本函式不排序，直接依輸入順序組裝 timeline。
 *
 * @param dayRow - trip_days row (含 hotel_poi_id)
 * @param entries - 該天的 trip_entries（已排序）
 * @param poiMap - poi_id → pois row 查找表（hotel + parking + 其他都進來）
 * @param parkingMap - hotelPoiId → parking POI list (來自 poi_relations)
 * @param entryPoisMap - canonical v2 entry POIs
 * @param segmentsMap - from_entry_id → segment row (給 travel response)
 */
// v2.33.94 simplify: 6 個 positional 參數 → object param。每加一 lookup table
// (v2.27 entryPois, v2.29 hotel, v2.30 segments) callsites 都要記順序，object
// 讓 caller 自說明且 type 補位失誤可抓。
export interface AssembleDayDeps {
  dayRow: Record<string, unknown>;
  entries: Record<string, unknown>[];
  poiMap: Map<number, Record<string, unknown>>;
  parkingMap: Map<number, Record<string, unknown>[]>;
  entryPoisMap: Map<number, EntryPoiBucket>;
  segmentsMap: Map<number, SegmentRow>;
}

export function assembleDay(deps: AssembleDayDeps): Record<string, unknown> {
  const { dayRow, entries, poiMap, parkingMap, entryPoisMap, segmentsMap } = deps;
  // Hotel ← trip_days.hotel_poi_id (FK to pois)
  let hotel: Record<string, unknown> | null = null;
  const hotelPoiId = dayRow.hotel_poi_id as number | null;
  if (hotelPoiId) {
    const hotelPoi = poiMap.get(hotelPoiId);
    if (hotelPoi) {
      hotel = { ...hotelPoi, parking: parkingMap.get(hotelPoiId) ?? [] };
    }
  }

  const timeline = entries.map((e) => {
    const eid = e.id as number;

    // v2.29.0 canonical model: master + alternates 全來自 trip_entry_pois
    const entryPoiBucket = entryPoisMap.get(eid);
    const master = entryPoiBucket?.master ?? null;
    const alternates = entryPoiBucket?.alternates ?? [];
    const stop_pois = entryPoiBucket?.stopPois ?? [];
    const entry_pois_version = entryPoiBucket?.version ?? null;

    // v2.29.0: travel object ← trip_segments (lookup by from_entry_id)
    // Pre-cutover: travel 從 entry.travel_* cols 取。Phase 2 完成後改 segments 為唯一 source。
    // Frontend 仍 expect { type, desc, min, distance_m, source } shape。
    const segment = segmentsMap.get(eid);
    const isSamePlace = segment != null && segment.no_travel === 1;
    const travel = segment
      ? {
          // v2.55.46: 同一地點/免交通 → type=null（不吐假 mode；否則 travel blob 會同時帶
          // type:'walk' + sameplace:true 矛盾，未來若有 consumer 沒先判 sameplace 會誤顯步行）。
          type: isSamePlace ? null : (segment.mode === 'driving' ? 'car' : segment.mode === 'walking' ? 'walk' : segment.mode),
          // v2.55.45: submode surface 到 read path（days?all / 分享列印），讓唯讀/列印面
          // 也能顯示單軌/公車等具體方式而非 generic「大眾運輸」。非 transit → null。
          submode: segment.mode === 'transit' ? segment.submode : null,
          // v2.55.46: 同一地點/免交通 → 讓唯讀/列印/分享面收合成「同一地點」而非顯示車程。
          sameplace: isSamePlace,
          desc: null as string | null,
          min: segment.min,
          distance_m: segment.distance_m,
          source: segment.source,
        }
      : null;

    return {
      ...e,
      travel,
      master,
      alternates,
      stop_pois,
      entry_pois_version,
    };
  });

  return {
    id: dayRow.id,
    day_num: dayRow.day_num,
    date: dayRow.date,
    day_of_week: dayRow.day_of_week,
    label: dayRow.label,
    /** v2.30.x (migration 0065)：Day-level OCC token. PUT /days/:num 帶 expectedDayVersion 比對。 */
    version: (dayRow as { version?: unknown }).version ?? 0,
    hotel,
    timeline,
  };
}

/**
 * Build the full `?all=1` days array: days + entries + segments + hotel/parking +
 * entry POIs → assembleDay per day. Extracted so GET /trips/:id/days?all=1 AND the
 * public share endpoint (GET /api/share/:token) render byte-identical timeline data
 * from one orchestration (no drift between authed view and public share).
 */
export async function buildAllDays(
  db: D1Database,
  tripId: string,
): Promise<Record<string, unknown>[]> {
  const [daysResult, entriesResult, segmentsMap] = await Promise.all([
    db.prepare('SELECT * FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC').bind(tripId).all(),
    db
      .prepare(
        `SELECT e.* FROM trip_entries e
         JOIN trip_days d ON e.day_id = d.id
         WHERE d.trip_id = ?
         ORDER BY e.day_id ASC, e.sort_order ASC`,
      )
      .bind(tripId)
      .all(),
    fetchTripSegmentsMap(db, tripId),
  ]);

  const dayRows = daysResult.results as Record<string, unknown>[];
  const entryRows = entriesResult.results as Record<string, unknown>[];

  const hotelPoiIds = [
    ...new Set(
      dayRows
        .map((d) => d.hotel_poi_id as number | null)
        .filter((v): v is number => v != null && v > 0),
    ),
  ];
  const { poiMap, parkingMap } = await fetchHotelAndParking(db, hotelPoiIds);

  const allEntryIds = entryRows.map((e) => e.id as number);
  const entryPoisMap = await fetchEntryPoisByEntries(db, allEntryIds);

  const entriesByDay = new Map<number, Record<string, unknown>[]>();
  for (const e of entryRows) {
    const dayId = e.day_id as number;
    if (!entriesByDay.has(dayId)) entriesByDay.set(dayId, []);
    entriesByDay.get(dayId)!.push(e);
  }

  return dayRows.map((day) =>
    assembleDay({
      dayRow: day,
      entries: entriesByDay.get(day.id as number) ?? [],
      poiMap,
      parkingMap,
      entryPoisMap,
      segmentsMap,
    }),
  );
}
