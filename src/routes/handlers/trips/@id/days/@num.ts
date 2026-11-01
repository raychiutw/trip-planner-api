import { logAudit } from '../../../../../lib/audit';
import { requireAuth, requireTripReadAccess, requireTripWrite } from '../../../../../lib/permissions';
import { replaceDayEntries, type BatchEntrySpec, type DayReplacementEntry } from '../../../../../lib/entry-write';
import { AppError } from '../../../../../errors';
import { batchFindOrCreatePois, type FindOrCreatePoiData } from '../../../../../lib/poi';
import { resolveEntryTimes } from '../../../../../lib/time';
import { validateDayBody, detectGarbledText } from '../../../../../lib/validate';
import { json, parseJsonBody, getAuth } from '../../../../../lib/utils';
import { normalizeReservation } from '../../../../../lib/reservation';
import type { Env } from '../../../../../env';
import {
  assembleDay,
  fetchEntryPoisByEntries,
  fetchHotelAndParking,
  fetchTripSegmentsMap,
} from '../../../../../lib/day-merge';

// ---------------------------------------------------------------------------
// GET /api/trips/:id/days/:num — canonical entry POIs + contextual day POIs
// ---------------------------------------------------------------------------

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { id, num } = context.params as { id: string; num: string };
  const db = context.env.DB;

  // v2.33.41 security: gate anonymous read.
  await requireTripReadAccess(db, getAuth(context), id);

  const day = await db
    .prepare('SELECT * FROM trip_days WHERE trip_id = ? AND day_num = ?')
    .bind(id, Number(num))
    .first() as Record<string, unknown> | null;

  if (!day) throw new AppError('DATA_NOT_FOUND');

  const dayId = day.id as number;

  // v2.29.0: trip_pois DROPPED. Hotel ← trip_days.hotel_poi_id; entry POIs ← trip_entry_pois;
  // travel ← trip_segments; parking ← poi_relations.
  const [entriesResult, segmentsMap] = await Promise.all([
    db.prepare('SELECT * FROM trip_entries WHERE day_id = ? ORDER BY sort_order ASC').bind(dayId).all(),
    fetchTripSegmentsMap(db, id),
  ]);

  const entryRows = entriesResult.results as Record<string, unknown>[];

  const hotelPoiId = day.hotel_poi_id as number | null;
  const { poiMap, parkingMap } = await fetchHotelAndParking(db, hotelPoiId ? [hotelPoiId] : []);

  const entryPoisMap = await fetchEntryPoisByEntries(db, entryRows.map((e) => e.id as number));

  const assembled = assembleDay({
    dayRow: day,
    entries: entryRows,
    poiMap,
    parkingMap,
    entryPoisMap,
    segmentsMap,
  });

  return json(assembled);
};

// ---------------------------------------------------------------------------
// PUT /api/trips/:id/days/:num — canonical entry POIs + contextual day POIs
// ---------------------------------------------------------------------------

type TimelineEntryBody = Record<string, unknown> & {
  shopping?: unknown[];
  stopPois?: unknown[];
  alternates?: unknown[];
  master?: unknown;
  travel?: { type?: unknown; desc?: unknown; min?: unknown };
};

type EntryPoiChoiceBuilder = {
  poiItemIdx?: number;
  poiId?: number;
  description: string | null;
  note: string | null;
  reservation: string | null;
  reservationUrl: string | null;
};

type ResolvedEntryPoiChoice = Omit<EntryPoiChoiceBuilder, 'poiItemIdx' | 'poiId'> & {
  poiId: number;
};

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** 先驗證會用到的形狀；不能把格式錯誤的 timeline / POI 過濾成空清單後覆寫舊 day。 */
function validateReplacementShape(body: Record<string, unknown>): void {
  function record(value: unknown, path: string): Record<string, unknown> {
    const result = recordValue(value);
    if (!result) throw new AppError('DATA_VALIDATION', `${path} 必須為物件`);
    for (const field of ['name', 'description', 'note', 'reservation', 'reservationUrl', 'reservation_url', 'hours', 'category', 'type', 'time', 'start_time', 'end_time']) {
      if (result[field] != null && typeof result[field] !== 'string') {
        throw new AppError('DATA_VALIDATION', `${path}.${field} 必須為文字`);
      }
    }
    for (const field of ['poiId', 'poi_id']) {
      if (result[field] != null && positiveInt(result[field]) === null) {
        throw new AppError('DATA_VALIDATION', `${path}.${field} 必須為正整數`);
      }
    }
    return result;
  }
  function records(value: unknown, path: string): Record<string, unknown>[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new AppError('DATA_VALIDATION', `${path} 必須為陣列`);
    return value.map((item, i) => record(item, `${path}[${i}]`));
  }
  for (const field of ['date', 'dayOfWeek', 'label']) {
    if (typeof body[field] !== 'string') throw new AppError('DATA_VALIDATION', `${field} 必須為文字`);
  }
  for (const [i, entry] of records(body.timeline, 'timeline').entries()) {
    for (const field of ['stopPois', 'alternates', 'shopping']) records(entry[field], `timeline[${i}].${field}`);
    if (entry.master != null) record(entry.master, `timeline[${i}].master`);
  }
  if (body.hotel != null) {
    const hotel = record(body.hotel, 'hotel');
    records(hotel.parking, 'hotel.parking');
  }
}

function canonicalChoiceInputs(entry: TimelineEntryBody): Array<{ item: Record<string, unknown>; defaultType: string }> {
  const stopPois = recordArray(entry.stopPois);
  if (stopPois.length > 0) return stopPois.map((item) => ({ item, defaultType: 'attraction' }));

  const master = recordValue(entry.master);
  const alternates = recordArray(entry.alternates);
  if (master || alternates.length > 0) {
    return [
      ...(master ? [{ item: master, defaultType: 'attraction' }] : []),
      ...alternates.map((item) => ({ item, defaultType: 'attraction' })),
    ];
  }

  return [];
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, num } = context.params as { id: string; num: string };
  const changedBy = auth.email;
  const db = context.env.DB;

  await requireTripWrite(db, auth, id);

  const day = await db
    .prepare('SELECT id, version FROM trip_days WHERE trip_id = ? AND day_num = ?')
    .bind(id, Number(num))
    .first() as { id: number; version: number } | null;

  if (!day) throw new AppError('DATA_NOT_FOUND');
  const dayId = day.id;
  const currentDayVersion = day.version ?? 0;

  // Snapshot old data for audit
  // v2.29.0: trip_pois DROPPED. Snapshot 只含 entries + day.hotel_poi_id。
  const [oldDay, oldEntries] = await Promise.all([
    db.prepare('SELECT hotel_poi_id FROM trip_days WHERE id = ?').bind(dayId).first<{ hotel_poi_id: number | null }>(),
    db.prepare('SELECT * FROM trip_entries WHERE day_id = ? ORDER BY sort_order ASC').bind(dayId).all(),
  ]);
  const snapshot = JSON.stringify({ dayId, hotelPoiId: oldDay?.hotel_poi_id ?? null, entries: oldEntries.results });

  type DayBody = {
    date?: string;
    dayOfWeek?: string;
    label?: string;
    hotel?: Record<string, unknown> & { shopping?: unknown[]; parking?: unknown[]; description?: unknown };
    timeline?: TimelineEntryBody[];
    /** v2.30.x (migration 0065)：Day-level OCC token。Client 帶 GET 時拿到的
     *  `version`，backend 比對 trip_days.version 不符 → 409 STALE_ENTRY，未帶
     *  則 backwards-compat 略過 check（既有 client 不會受影響）。 */
    expectedDayVersion?: number;
  };
  const body = await parseJsonBody<DayBody>(context.request);
  validateReplacementShape(body);

  // v2.30.x (migration 0065)：Day-level OCC check — body 帶 expectedDayVersion 才驗
  if (body.expectedDayVersion !== undefined && body.expectedDayVersion !== currentDayVersion) {
    throw new AppError('STALE_ENTRY');
  }

  const validation = validateDayBody(body);
  if (!validation.ok) throw new AppError('DATA_VALIDATION', validation.error);

  // Garbled text detection
  const timelineEntries = Array.isArray(body.timeline) ? body.timeline : [];
  for (let i = 0; i < timelineEntries.length; i++) {
    const e = timelineEntries[i]!;
    if ('title' in e) {
      throw new AppError('DATA_VALIDATION', `timeline[${i}].title 已移除，請使用 name 或 stopPois`);
    }
    if ('restaurants' in e) {
      throw new AppError('DATA_VALIDATION', `timeline[${i}].restaurants 已移除，請使用 stopPois`);
    }
    if ('stop_pois' in e) {
      throw new AppError('DATA_VALIDATION', `timeline[${i}].stop_pois 已移除，請使用 stopPois`);
    }
    if ('poi' in e) {
      throw new AppError('DATA_VALIDATION', `timeline[${i}].poi 已移除，請使用 master 或 stopPois`);
    }
    for (const f of ['name', 'description', 'note'] as const) {
      const val = e[f as keyof typeof e];
      if (typeof val === 'string' && detectGarbledText(val)) {
        throw new AppError('DATA_ENCODING', `timeline[${i}].${f} 包含疑似亂碼`);
      }
    }
  }

  // Phase 2: poi_type 白名單驗證（避免 CHECK 失敗讓 batch 炸在半途）
  const ALLOWED_POI_TYPES = new Set(['hotel', 'restaurant', 'shopping', 'parking', 'attraction', 'transport', 'activity', 'other']);
  for (let i = 0; i < timelineEntries.length; i++) {
    const pt = (timelineEntries[i] as Record<string, unknown>).poi_type;
    if (pt !== undefined && (typeof pt !== 'string' || !ALLOWED_POI_TYPES.has(pt))) {
      throw new AppError('DATA_VALIDATION', `timeline[${i}].poi_type 無效（允許：${[...ALLOWED_POI_TYPES].join(', ')}）`);
    }
  }

  // round 5 fix (was round 4 adv-C5): snapshot alternates per OLD entry, each entry's alts
  // kept as a separate list so restore can match 1:1 without conflation. Round 4 keyed by
  // master_poi_id and merged lists from multiple old entries — if two old entries shared
  // a master POI, INSERT OR IGNORE silently dropped collisions (round 5 HIGH finding).
  //
  // Strategy: snapshot each old entry's master POI + alt list. On restore, for each new
  // entry, find the FIRST old snapshot with matching master POI that hasn't been claimed
  // yet, transfer its alts. Edge cases:
  //  - User replaces an entry's POI entirely → no match → alts gracefully lost (acceptable;
  //    they belonged to the replaced POI)
  //  - Two new entries with same master POI → first claims the first old snapshot's alts,
  //    second claims the second old snapshot's alts (1:1 by order)
  //  - Read trip_entry_pois.sort_order=1 (canonical master since v2.29.0 DROP trip_entries.poi_id)
  type OldEntrySnapshot = { masterPoiId: number; alts: NonNullable<DayReplacementEntry['restoredAlternates']> };
  const oldEntrySnapshots: OldEntrySnapshot[] = [];
  {
    const entriesRow = await db
      .prepare(
        `SELECT e.id AS entry_id, tep.poi_id AS master_poi_id
         FROM trip_entries e
         JOIN trip_entry_pois tep ON tep.entry_id = e.id AND tep.sort_order = 1
         WHERE e.day_id = ?
         ORDER BY e.sort_order ASC`,
      )
      .bind(dayId)
      .all<{ entry_id: number; master_poi_id: number }>();
    const entryIdToSnapshot = new Map<number, OldEntrySnapshot>();
    for (const e of entriesRow.results) {
      const snap: OldEntrySnapshot = { masterPoiId: e.master_poi_id, alts: [] };
      oldEntrySnapshots.push(snap);
      entryIdToSnapshot.set(e.entry_id, snap);
    }
    if (entriesRow.results.length > 0) {
      const altPlaceholders = entriesRow.results.map(() => '?').join(',');
      const altsRow = await db
        .prepare(
          `SELECT entry_id, poi_id, sort_order, description, note, reservation, reservation_url
           FROM trip_entry_pois
           WHERE entry_id IN (${altPlaceholders}) AND sort_order > 1`,
        )
        .bind(...entriesRow.results.map((e) => e.entry_id))
        .all<{ entry_id: number; poi_id: number; sort_order: number; description: string | null; note: string | null; reservation: string | null; reservation_url: string | null }>();
      for (const a of altsRow.results) {
        entryIdToSnapshot.get(a.entry_id)?.alts.push({ poiId: a.poi_id, sortOrder: a.sort_order,
          description: a.description, note: a.note, reservation: a.reservation, reservationUrl: a.reservation_url,
        });
      }
    }
  }

  try {
    const timeline = Array.isArray(body.timeline) ? body.timeline : [];

    // Collect all POI data for batch find-or-create (eliminates N+1 sequential queries)
    const poiItems: FindOrCreatePoiData[] = [];
    const parkingPoiIndices: number[] = [];
    let hotelPoiIdx = -1;
    // Phase 2: entry-level POI — each timeline entry gets a poi_id FK into pois master.
    // -1 means no POI needed (empty title / placeholder entry).
    const entryPoiIdx: number[] = new Array(timeline.length).fill(-1);

    // Hotel
    if (body.hotel) {
      const h = body.hotel;
      hotelPoiIdx = poiItems.length;
      // Migration 0055 (v2.25.5): hours 寫進 pois master，不再寫 trip_pois.hours。
      poiItems.push({
        name: (h.name as string) || '', type: 'hotel',
        description: h.description as string,
        hours: h.hours as string,
        lat: h.lat as number, lng: h.lng as number, source: 'ai',
      });
      // v2.29.0: hotel 改寫 trip_days.hotel_poi_id (FK to pois)。
      // hotel-specific cols (checkout/breakfast/reservation) 已 DROPPED, body 帶值會被 ignore。
      // Hotel parking — 仍寫 poi_relations (relation_type='parking')；trip_pois.parking row 不再寫。
      if (Array.isArray(h.parking)) {
        for (const p of h.parking as Record<string, unknown>[]) {
          const parkIdx = poiItems.length;
          poiItems.push({
            name: (p.name as string) || '停車場', type: 'parking',
            description: p.price ? `費用：${p.price}` : null,
            lat: p.lat as number, lng: p.lng as number, source: 'ai',
          });
          parkingPoiIndices.push(parkIdx);
        }
      }

      // v2.29.0: hotel.shopping (day-level) DELETED — design 決定不遷，user 接受 data loss。
      // body.hotel.shopping 帶值會被 ignore (frontend 已停送)。
    }

    // Entry-level POI (Phase 2)：每個 timeline entry 對應一筆 pois master。
    // type 來自 body.timeline[].poi_type，預設 attraction；機場/車站請傳 transport、預訂體驗請傳 activity。
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i] as Record<string, unknown>;
      if (canonicalChoiceInputs(timeline[i]!).length > 0) continue;
      const name = typeof e.name === 'string' ? e.name.trim() : '';
      if (!name) continue;
      const rawType = typeof e.poi_type === 'string' ? e.poi_type : 'attraction';
      entryPoiIdx[i] = poiItems.length;
      poiItems.push({
        name,
        type: rawType,
        description: (e.description as string | undefined) ?? null,
        lat: (e.lat as number | undefined) ?? null,
        lng: (e.lng as number | undefined) ?? null,
        rating: (e.rating as number | undefined) ?? null,
        source: 'ai',
      });
    }

    // Canonical entry POI choices + contextual entry shopping.
    const entryPoiChoiceBuilders: EntryPoiChoiceBuilder[][] = timeline.map(() => []);

    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i]!;

      for (const { item, defaultType } of canonicalChoiceInputs(e)) {
        const directPoiId = positiveInt(item.poiId ?? item.poi_id);
        const choice: EntryPoiChoiceBuilder = {
          description: stringOrNull(item.description),
          note: stringOrNull(item.note),
          // D 寫入防堵：被誤存成 JSON 的訂位狀態 → 人話文字（防 AI 生成路徑再污染 reservation）。
          reservation: normalizeReservation(stringOrNull(item.reservation)),
          reservationUrl: stringOrNull(item.reservation_url ?? item.reservationUrl),
        };

        if (directPoiId !== null) {
          entryPoiChoiceBuilders[i]!.push({ ...choice, poiId: directPoiId });
          continue;
        }

        const name = stringOrNull(item.name);
        if (!name) continue;

        const choiceType = stringOrNull(item.type) ?? defaultType;
        if (!ALLOWED_POI_TYPES.has(choiceType)) {
          throw new AppError('DATA_VALIDATION', `timeline[${i}].stopPois.type 無效（允許：${[...ALLOWED_POI_TYPES].join(', ')}）`);
        }

        const pIdx = poiItems.length;
        poiItems.push({
          name,
          type: choiceType,
          description: stringOrNull(item.description),
          rating: numberOrNull(item.rating),
          category: stringOrNull(item.category),
          hours: stringOrNull(item.hours),
          source: 'ai',
          price: stringOrNull(item.price),
          lat: numberOrNull(item.lat),
          lng: numberOrNull(item.lng),
        });
        entryPoiChoiceBuilders[i]!.push({ ...choice, poiItemIdx: pIdx });
      }

      // v2.29.0: entry-level shopping 改進 trip_entry_pois (sort_order = next, 同 main alternates).
      // body.shopping 仍接受（backward-compat），但 INSERT 到 trip_entry_pois 而非 trip_pois。
      if (Array.isArray((e as Record<string, unknown>).shopping)) {
        for (const s of (e as Record<string, unknown>).shopping as Record<string, unknown>[]) {
          const sIdx = poiItems.length;
          poiItems.push({
            name: (s.name as string) || '', type: 'shopping',
            rating: s.rating as number,
            category: s.category as string, hours: s.hours as string, source: 'ai',
          });
          // 收進 entryPoiChoiceBuilders[i] 跟 main alternates 一視同仁
          entryPoiChoiceBuilders[i]!.push({
            description: null,
            note: stringOrNull(s.note),
            reservation: null,
            reservationUrl: null,
            poiItemIdx: sIdx,
          });
        }
      }
    }

    // Batch resolve all POIs (2–3 DB round-trips instead of N)
    const poiIds = await batchFindOrCreatePois(db, poiItems, { policy: 'fill-null' });

    const directChoicePoiIds = new Set<number>();
    for (const choices of entryPoiChoiceBuilders) {
      for (const choice of choices) {
        if (choice.poiId !== undefined) directChoicePoiIds.add(choice.poiId);
      }
    }
    if (directChoicePoiIds.size > 0) {
      const directIds = [...directChoicePoiIds];
      const placeholders = directIds.map(() => '?').join(',');
      const existing = await db
        .prepare(`SELECT id FROM pois WHERE id IN (${placeholders})`)
        .bind(...directIds)
        .all<{ id: number }>();
      const existingIds = new Set(existing.results.map((row) => row.id));
      const missing = directIds.filter((poiId) => !existingIds.has(poiId));
      if (missing.length > 0) {
        throw new AppError('DATA_VALIDATION', `stopPois.poiId 不存在: ${missing.join(', ')}`);
      }
    }

    function resolveEntryChoices(index: number): ResolvedEntryPoiChoice[] {
      const seen = new Set<number>();
      const resolved: ResolvedEntryPoiChoice[] = [];
      for (const choice of entryPoiChoiceBuilders[index] ?? []) {
        const poiId = choice.poiId ?? (choice.poiItemIdx !== undefined ? poiIds[choice.poiItemIdx] : undefined);
        if (typeof poiId !== 'number' || seen.has(poiId)) continue;
        seen.add(poiId);
        resolved.push({
          poiId,
          description: choice.description,
          note: choice.note,
          reservation: choice.reservation,
          reservationUrl: choice.reservationUrl,
        });
      }
      return resolved;
    }

    // POI 與備選計畫都先準備好，完整 day 交由 entry intake 原子提交。
    const fallbackByIndex = new Map<number, { poiId: number; note: string | null }>();
    const specs: DayReplacementEntry[] = timeline.map((e, i) => {
      const { startTime, endTime } = resolveEntryTimes(e as Record<string, unknown>);
      const entryLevelNote = stringOrNull((timeline[i] as Record<string, unknown>).note);
      const explicitChoices = resolveEntryChoices(i);
      // migration 0078：正選（idx 0）自己沒 note → 繼承 entry-level note；備選維持各自 note。
      let pois: BatchEntrySpec['pois'] = explicitChoices.map((c, idx) => ({
        poiId: c.poiId, description: c.description, note: idx === 0 ? (c.note ?? entryLevelNote) : c.note, reservation: c.reservation, reservationUrl: c.reservationUrl,
      }));
      if (pois.length === 0) {
        const pIdx = entryPoiIdx[i]!;
        const poiId = pIdx >= 0 ? poiIds[pIdx] : undefined;
        if (typeof poiId === 'number') {
          pois = [{ poiId, note: entryLevelNote }];
          fallbackByIndex.set(i, { poiId, note: entryLevelNote });
        }
      }
      return { dayId, sortOrder: i, startTime, endTime, description: (e.description as string | null | undefined) ?? null, pois };
    });
    const claimed = new Set<OldEntrySnapshot>();
    for (const [index, fallback] of fallbackByIndex) {
      const match = oldEntrySnapshots.find(
        (s) => s.masterPoiId === fallback.poiId && !claimed.has(s) && s.alts.length > 0,
      );
      if (!match) continue;
      claimed.add(match);
      specs[index]!.restoredAlternates = match.alts;
    }
    await replaceDayEntries(db, {
      dayId, date: body.date!, dayOfWeek: body.dayOfWeek!, label: body.label!, entries: specs,
      ...(hotelPoiIdx >= 0 ? { hotel: { poiId: poiIds[hotelPoiIdx]!, parkingPoiIds: parkingPoiIndices.map((i) => poiIds[i]!) } } : {}),
    });

    // Audit log AFTER the complete day commits (no phantom success on rollback)
    await logAudit(db, {
      tripId: id, tableName: 'trip_days', recordId: dayId, action: 'update', changedBy,
      snapshot, diffJson: JSON.stringify({ day_num: Number(num), overwrite: true }),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    await logAudit(db, {
      tripId: id, tableName: 'trip_days', recordId: dayId, action: 'error', changedBy,
      diffJson: JSON.stringify({ error: 'Day replacement rolled back', message: err instanceof Error ? err.message : String(err) }),
    });
    throw new AppError('DATA_SAVE_FAILED', '儲存失敗，請稍後再試');
  }

  // v2.30.x (migration 0065)：surface new OCC token 給 client 下次 PUT 用。
  // Re-fetch the stored version after the atomic day replacement rather than
  // returning the local guess (currentDayVersion + 1) — strictly more correct and
  // matches the canonical D1 read-back pattern.
  const stored = await db
    .prepare('SELECT version FROM trip_days WHERE id = ?')
    .bind(dayId)
    .first<{ version: number }>();
  return json({ ok: true, dayVersion: stored?.version ?? currentDayVersion + 1 });
};

// ---------------------------------------------------------------------------
// DELETE /api/trips/:id/days/:num — remove a day (cascade entries via FK)
// ---------------------------------------------------------------------------
//
// v2.33.0: 移除某天 + cascade trip_entries（FK ON DELETE CASCADE）+ 後續 days
// day_num 上移 + date 上移（trip 整體上縮 1 天）。最後一天禁刪（trip 至少 1 天）。
//
// Note：返回 { ok: true, removedEntryCount } 讓 frontend 可顯示 toast
// 「Day N 已刪除（連同 X 個景點）」。
//
// Auth: trip write permission（owner/admin/member; viewer 拒）。

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, num } = context.params as { id: string; num: string };
  const dayNum = Number(num);
  if (!Number.isFinite(dayNum) || dayNum < 1) {
    throw new AppError('DATA_VALIDATION', 'day_num 必須為正整數');
  }

  const db = context.env.DB;
  await requireTripWrite(db, auth, id);

  // 取目標 day + 計算 trip 共幾天（最後一天禁刪）
  const target = await db
    .prepare('SELECT id, day_num, date FROM trip_days WHERE trip_id = ? AND day_num = ?')
    .bind(id, dayNum)
    .first<{ id: number; day_num: number; date: string | null }>();
  if (!target) throw new AppError('DATA_NOT_FOUND', '找不到該天');

  const totalRow = await db
    .prepare('SELECT COUNT(*) AS c FROM trip_days WHERE trip_id = ?')
    .bind(id)
    .first<{ c: number }>();
  const total = Number(totalRow?.c || 0);
  if (total <= 1) {
    throw new AppError('DATA_VALIDATION', '行程至少要保留 1 天，無法刪除最後一天');
  }

  // 算將被 cascade 刪除的 entries 數（FK ON DELETE CASCADE 處理實際刪除）
  const entryCountRow = await db
    .prepare('SELECT COUNT(*) AS c FROM trip_entries WHERE day_id = ?')
    .bind(target.id)
    .first<{ c: number }>();
  const removedEntryCount = Number(entryCountRow?.c || 0);

  // 後續 days: day_num -= 1（date / day_of_week 不動，避免「日期 shift up」
  // 違反 prepend / delete-first 對稱性）。
  //
  // v2.33.1 fix：v2.33.0 額外 shift dates 上移 1 天 → user prepend 加 4/30 後
  // delete-first 預期回到原 5/1，但實際變 4/30-5/4（trip 提前 1 天）。
  // 改為只 renumber day_num；dates 保留 → 若中間刪，會留 gap（acceptable，
  // Tripline 不強制 contiguous dates）。
  //
  // SQLite UNIQUE(trip_id, day_num) 在 statement end 才檢查 OK，但 D1 row-by-row
  // 檢查需要逐 row UPDATE，每 row 自己的 statement → 自然安全。
  const { results: subsequent } = await db
    .prepare('SELECT id, day_num FROM trip_days WHERE trip_id = ? AND day_num > ? ORDER BY day_num ASC')
    .bind(id, dayNum)
    .all<{ id: number; day_num: number }>();

  // Delete + cascade + renumber must commit together; a failed renumber keeps the old day.
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM trip_days WHERE id = ?').bind(target.id)];
  for (const r of subsequent ?? []) {
    stmts.push(db.prepare('UPDATE trip_days SET day_num = ? WHERE id = ?').bind(r.day_num - 1, r.id));
  }
  await db.batch(stmts);

  return json({ ok: true, removedEntryCount });
};
