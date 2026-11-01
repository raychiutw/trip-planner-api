import { requireAuth, requireTripWrite } from '../../../../../../lib/permissions';
import { AppError } from '../../../../../../errors';
import { createEntry } from '../../../../../../lib/entry-write';
import { resolveEntryTimes } from '../../../../../../lib/time';
import { validateEntryBody, detectGarbledText } from '../../../../../../lib/validate';
import { json, parseJsonBody } from '../../../../../../lib/utils';
import type { Env } from '../../../../../../env';

/**
 * POST /api/trips/:id/days/:num/entries — 新增 entry 到指定天
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id, num } = context.params as { id: string; num: string };
  const dayNum = Number(num);
  if (!Number.isInteger(dayNum) || dayNum < 1) {
    throw new AppError('DATA_VALIDATION', 'day_num 格式錯誤');
  }

  const db = context.env.DB;
  const changedBy = auth.email;

  await requireTripWrite(db, auth, id);

  const day = await db
    .prepare('SELECT id FROM trip_days WHERE trip_id = ? AND day_num = ?')
    .bind(id, dayNum)
    .first() as { id: number } | null;

  if (!day) throw new AppError('DATA_NOT_FOUND');
  const dayId = day.id;

  const body = await parseJsonBody<Record<string, unknown>>(context.request);

  const validation = validateEntryBody(body);
  if (!validation.ok) throw new AppError('DATA_VALIDATION', validation.error);

  // 亂碼偵測
  for (const f of ['name', 'description', 'note']) {
    if (f in body && typeof body[f] === 'string' && detectGarbledText(body[f] as string)) {
      throw new AppError('DATA_ENCODING', `欄位 ${f} 包含疑似亂碼，請確認 encoding 為 UTF-8`);
    }
  }

  // Phase 2: poi_type 白名單（避免 pois.type CHECK 失敗）
  const ALLOWED_POI_TYPES = new Set(['hotel', 'restaurant', 'shopping', 'parking', 'attraction', 'transport', 'activity', 'other']);
  if (body.poi_type !== undefined && (typeof body.poi_type !== 'string' || !ALLOWED_POI_TYPES.has(body.poi_type))) {
    throw new AppError('DATA_VALIDATION', `poi_type 無效（允許：${[...ALLOWED_POI_TYPES].join(', ')}）`);
  }

  // sort_order：指定則直接寫該值（collision 由 resort 拉正），否則 append。
  let placement: { sortOrder: number } | undefined;
  if (typeof body.sort_order === 'number') {
    if (!Number.isInteger(body.sort_order) || body.sort_order < 0) {
      throw new AppError('DATA_VALIDATION', 'sort_order 必須為非負整數');
    }
    placement = { sortOrder: body.sort_order };
  }

  // Phase 2：name 必須為非空白字串（validateEntryBody 只檢 falsiness，空白字串通過）
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new AppError('DATA_VALIDATION', 'name 不可為空白');

  // v2.29.0: resolveEntryTimes 仍接受 legacy body.time → 拆 start/end。
  const { startTime, endTime } = resolveEntryTimes(body);
  // migration 0078: entry-level note → 新 master 的 per-POI note。trim 後空字串視為無備註。
  const masterNote =
    typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;

  // #1257 entry intake：POI resolve、INSERT、正選、version、resort、audit、補償全在 createEntry。
  const { row } = await createEntry(db, {
    dayId,
    poi: {
      data: {
        name,
        type: (body.poi_type as string) || 'attraction',
        description: (body.description as string | undefined) ?? null,
        lat: (body.lat as number | undefined) ?? null,
        lng: (body.lng as number | undefined) ?? null,
        rating: (body.rating as number | undefined) ?? null,
        // v2.31.94: forward body.source to pois.source as dedup/audit signal.
        source: (typeof body.source === 'string' && body.source) || 'ai',
      },
      policy: 'fill-null',
    },
    startTime,
    endTime,
    description: (body.description as string | undefined) ?? null,
    note: masterNote,
    source: (typeof body.source === 'string' && body.source) || 'ai',
    placement,
    audit: { tripId: id, changedBy, diff: { day_num: dayNum, poiName: name } },
  });

  return json(row, 201);
};
