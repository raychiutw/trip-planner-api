/** New-trip creation owns write order, ID remapping and compensation across D1 batches. */
import { AppError } from '../errors';
import { findOrCreatePoi, type FindOrCreatePoiData } from './poi';
import { createEntriesBatch, type BatchEntrySpec, type EntryPoiFields } from './entry-write';
import { reqId, rollbackTrip, runChunked } from './trip-write';

type Poi = { data: FindOrCreatePoiData; fields: EntryPoiFields };
type Entry = Omit<BatchEntrySpec, 'dayId' | 'pois'> & { key: number; pois: Poi[] };

export interface NewTripPlan {
  tripId: string;
  ownerId: string;
  name: string;
  title: string | null;
  description: string | null;
  countries: string;
  published: number;
  dataSource: string;
  lang: string;
  destinations: Array<{ name: string; lat: number | null; lng: number | null; dayQuota: number | null; subAreas: string | null }>;
  notes: D1PreparedStatement[];
  days: Array<{ dayNum: number; date: string; dayOfWeek: string; label: string; hotel: FindOrCreatePoiData | null; entries: Entry[] }>;
  segments: Array<{ fromKey: number; toKey: number; mode: string; submode: string | null; min: number | null; distanceM: number | null; source: string | null; noTravel: number | null }>;
  audit: { changedBy: string; diff: Record<string, unknown> };
  failureDetail: string;
}

export async function createTripFromPlan(db: D1Database, plan: NewTripPlan): Promise<void> {
  const { tripId } = plan;
  const entryIds: number[] = [];
  const createdPoiIds: number[] = [];
  let stage = 'trip';
  const resolve = (data: FindOrCreatePoiData) => findOrCreatePoi(db, data, {
    policy: 'fill-null', createdPoiIds, defaultCountry: null,
  });

  try {
    await runChunked(db, [
      db.prepare('INSERT INTO trips (id, name, owner_user_id, title, description, countries, published, data_source, lang) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(tripId, plan.name, plan.ownerId, plan.title, plan.description, plan.countries, plan.published, plan.dataSource, plan.lang),
      db.prepare('INSERT INTO trip_permissions (user_id, trip_id, role) VALUES (?,?,?)').bind(plan.ownerId, tripId, 'owner'),
      ...plan.destinations.map((d, i) => db.prepare('INSERT INTO trip_destinations (trip_id, dest_order, name, lat, lng, day_quota, sub_areas) VALUES (?,?,?,?,?,?,?)')
        .bind(tripId, i + 1, d.name, d.lat, d.lng, d.dayQuota, d.subAreas)),
      ...plan.notes,
    ]);

    stage = 'days';
    const dayIds: number[] = [];
    await runChunked(db, plan.days.map((d) => db.prepare('INSERT INTO trip_days (trip_id, day_num, date, day_of_week, label) VALUES (?,?,?,?,?) RETURNING id')
      .bind(tripId, d.dayNum, d.date, d.dayOfWeek, d.label)), (r) => dayIds.push(reqId(r)));

    stage = 'entries';
    const specs: BatchEntrySpec[] = [];
    const keys: number[] = [];
    for (let di = 0; di < plan.days.length; di++) {
      for (const entry of plan.days[di]!.entries) {
        const pois: BatchEntrySpec['pois'] = [];
        for (const poi of entry.pois) pois.push({ poiId: await resolve(poi.data), ...poi.fields });
        specs.push({ dayId: dayIds[di]!, sortOrder: entry.sortOrder, startTime: entry.startTime,
          endTime: entry.endTime, description: entry.description, source: entry.source, pois });
        keys.push(entry.key);
      }
    }
    const entryIdByKey = new Map<number, number>();
    await createEntriesBatch(db, specs, {
      audit: { tripId, ...plan.audit },
      onEntryId: (id, index) => { entryIds.push(id); entryIdByKey.set(keys[index]!, id); },
    });

    stage = 'hotel and segments';
    const tail: D1PreparedStatement[] = [];
    for (let di = 0; di < plan.days.length; di++) {
      const hotel = plan.days[di]!.hotel;
      if (hotel) tail.push(db.prepare('UPDATE trip_days SET hotel_poi_id = ? WHERE id = ?').bind(await resolve(hotel), dayIds[di]!));
    }
    for (const segment of plan.segments) {
      const from = entryIdByKey.get(segment.fromKey);
      const to = entryIdByKey.get(segment.toKey);
      if (from === undefined || to === undefined) continue;
      tail.push(db.prepare('INSERT INTO trip_segments (trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, version, no_travel) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
        .bind(tripId, from, to, segment.mode, segment.submode, segment.min, segment.distanceM,
          segment.source, segment.source === 'google' ? Date.now() : null, segment.noTravel));
    }
    await runChunked(db, tail);
  } catch (error) {
    try {
      await rollbackTrip(db, tripId, entryIds, createdPoiIds);
    } catch (cleanupError) {
      console.error('[trip creation] create and compensation failed', { tripId, stage, error, cleanupError });
      throw new AppError('SYS_DB_ERROR', `${plan.failureDetail}；清理失敗，請聯絡支援`);
    }
    if (error instanceof AppError) throw error;
    console.error('[trip creation] failed and compensated', { tripId, stage, error });
    throw new AppError('SYS_DB_ERROR', plan.failureDetail);
  }
}
