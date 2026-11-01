/**
 * POST /api/trips/:id/entries/:eid/copy
 *
 * v2.10 Wave 1 Item 2 — 複製 entry 到目標 day。對應 V3 mockup ⎘ button +
 * EntryActionPopover(action='copy')。
 *
 * Body:
 *   {
 *     targetDayId: number,    // 必填，必須屬於同 trip
 *     sortOrder?: number,     // 選填，預設追加到目標 day 末尾
 *     time?: string | null,   // 選填，覆寫 source.time
 *   }
 *
 * Logic:
 *   1. perm check + verifyEntryBelongsToTrip
 *   2. SELECT source entry
 *   3. validate targetDayId 屬於同 trip
 *   4. INSERT new entry with day_id = targetDayId, sort_order, 其他欄位 copy
 *   5. SELECT trip_entry_pois WHERE entry_id = source → INSERT canonical POI copies
 *   6. logAudit action='create' with diff source ref
 *   7. Return new entry row
 */

import { createEntriesBatch } from '../../../../../../lib/entry-write';
import { hasWritePermission, verifyEntryBelongsToTrip, requireAuth} from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { parseTime } from '../../../../../../lib/time';
import { json, parseJsonBody, parseIntParam } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

interface CopyEntryBody {
  targetDayId: number;
  sortOrder?: number;
  time?: string | null;
}

interface SourceEntryPoi {
  poi_id: number;
  sort_order: number;
  description: string | null;
  note: string | null;
  reservation: string | null;
  reservation_url: string | null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, eid: eidStr } = context.params as { id: string; eid: string };
  const eid = parseIntParam(eidStr);
  if (!eid) throw new AppError('DATA_VALIDATION', 'ID 格式錯誤');
  const db = context.env.DB;
  const changedBy = auth.email;

  const [hasPerm, belongsToTrip] = await Promise.all([
    hasWritePermission(db, auth, id),
    verifyEntryBelongsToTrip(db, eid, id),
  ]);
  if (!hasPerm) throw new AppError('PERM_DENIED');
  if (!belongsToTrip) throw new AppError('DATA_NOT_FOUND');

  const body = await parseJsonBody<Partial<CopyEntryBody>>(context.request);
  const targetDayId = body.targetDayId;
  if (typeof targetDayId !== 'number' || !Number.isInteger(targetDayId) || targetDayId <= 0) {
    throw new AppError('DATA_VALIDATION', 'targetDayId 必須是正整數');
  }

  // 驗證 targetDay 屬於同 trip（防越權 copy 到別 trip）
  const targetDay = await db
    .prepare('SELECT trip_id FROM trip_days WHERE id = ?')
    .bind(targetDayId)
    .first() as { trip_id: string } | null;
  if (!targetDay) throw new AppError('DATA_NOT_FOUND', '指定的 day 不存在');
  if (targetDay.trip_id !== id) throw new AppError('PERM_DENIED', '不可將 entry 複製到其他 trip');

  // SELECT source entry（已驗證 belongsToTrip）
  const source = await db
    .prepare('SELECT start_time, end_time, description, source FROM trip_entries WHERE id = ?')
    .bind(eid)
    .first() as Record<string, unknown> | null;
  if (!source) throw new AppError('DATA_NOT_FOUND');

  const sourceStopPois = (await db
    .prepare(
      `SELECT poi_id, sort_order, description, note, reservation, reservation_url
       FROM trip_entry_pois
       WHERE entry_id = ?
       ORDER BY sort_order ASC`,
    )
    .bind(eid)
    .all<SourceEntryPoi>()).results ?? [];

  // sortOrder 預設追加到目標 day 末尾
  let sortOrder = body.sortOrder;
  if (typeof sortOrder !== 'number') {
    const maxRow = await db
      .prepare('SELECT MAX(sort_order) as maxSort FROM trip_entries WHERE day_id = ?')
      .bind(targetDayId)
      .first() as { maxSort: number | null } | null;
    sortOrder = (maxRow?.maxSort ?? -1) + 1;
  }

  // v2.29.0: trip_entries.{time, poi_id, travel_*} DROPPED. copy 只搬 start_time/end_time。
  // body.time legacy 入口仍接受（parseTime 拆 start/end），但 schema 不再寫 time。
  let copyStartTime: string | null;
  let copyEndTime: string | null;
  if (body.time !== undefined) {
    const parsed = parseTime(typeof body.time === 'string' ? body.time : null);
    copyStartTime = parsed.start;
    copyEndTime = parsed.end;
  } else {
    copyStartTime = (source.start_time as string | null) ?? null;
    copyEndTime = (source.end_time as string | null) ?? null;
  }

  // INSERT new entry — copy 所有 source 欄位除了 id、day_id、sort_order、time/poi_id/travel_*
  // migration 0078: trip_entries.note DROPPED — 不再 copy entry-level note。per-POI 備註
  // 隨下方 trip_entry_pois batch（含 row.note）一起複製，master + 每個 alternate 的 note 保留。
  // #1258 entry intake 批次入口：entry + 正選/備選（含各自 note/reservation）+ version +
  // audit + 補償 DELETE 全在 createEntriesBatch。複製沿用來源的 poi_id 不 resolve。
  let newRow: Record<string, unknown> | undefined;
  await createEntriesBatch(db, [{
    dayId: targetDayId,
    sortOrder,
    startTime: copyStartTime,
    endTime: copyEndTime,
    description: source.description as string | null,
    source: source.source as string | null,
    pois: sourceStopPois.map((row) => ({
      poiId: row.poi_id,
      description: row.description,
      note: row.note,
      reservation: row.reservation,
      reservationUrl: row.reservation_url,
    })),
  }], {
    audit: { tripId: id, changedBy, diff: { copiedFromEntryId: eid, targetDayId } },
    onEntryId: (_id, _idx, row) => { newRow = row; },
  });
  if (!newRow) throw new AppError('DATA_SAVE_FAILED', '複製 entry 失敗');

  return json(newRow);
};
