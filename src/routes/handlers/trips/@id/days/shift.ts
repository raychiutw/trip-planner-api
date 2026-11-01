/**
 * POST /api/trips/:id/days/shift
 *
 * v2.33.8: 整體平移行程 — body `{ startDate: 'YYYY-MM-DD' }`，
 * 計算 delta = startDate - min(existing date)，batch UPDATE 所有
 * trip_days 的 date + day_of_week。
 *
 * - Gap-preserving：每個 day 都加同樣 delta，原 dates 之間的 gap 保留
 *   (e.g. 5/1, 5/2, 5/4 shift +3 → 5/4, 5/5, 5/7)
 * - 拒空 trip / 有 null date 的 trip
 * - Auth: trip write permission
 *
 * Returns: { ok: true, newStartDate, newEndDate, daysShifted }
 */
import { requireAuth, requireTripWrite } from '../../../../../lib/permissions';
import { logAudit } from '../../../../../lib/audit';
import { AppError } from '../../../../../errors';
import { json } from '../../../../../lib/utils';
import type { Env } from '../../../../../env';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MS_PER_DAY = 86_400_000;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const tripId = context.params.id as string;
  if (!tripId) throw new AppError('DATA_VALIDATION', '缺少 tripId');

  const db = context.env.DB;
  await requireTripWrite(db, auth, tripId);

  const trip = await db.prepare('SELECT id FROM trips WHERE id = ?').bind(tripId).first();
  if (!trip) throw new AppError('DATA_NOT_FOUND', '找不到該行程');

  const body = (await context.request.json().catch(() => ({}))) as { startDate?: string };
  if (typeof body.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
    throw new AppError('DATA_VALIDATION', 'startDate 必須為 YYYY-MM-DD 格式');
  }
  const newStartDate = body.startDate;

  const { results } = await db
    .prepare('SELECT id, day_num, date FROM trip_days WHERE trip_id = ? ORDER BY day_num ASC')
    .bind(tripId)
    .all<{ id: number; day_num: number; date: string | null }>();
  const existing = results || [];

  if (existing.length === 0) {
    throw new AppError('DATA_VALIDATION', '行程沒有任何天可平移');
  }
  if (existing.some((r) => !r.date)) {
    throw new AppError('DATA_VALIDATION', '行程有日期未設定的天，無法整體平移');
  }

  // 計算 delta（以 day_num=1 的 date 為基準，不是 min date — day_num 1 永遠是
  // Day 1，即使中間 deletion 留下 gap，user 想的「Day 1 起始日期」就是它）
  const day1 = existing.find((r) => r.day_num === 1);
  if (!day1 || !day1.date) {
    throw new AppError('DATA_VALIDATION', 'Day 1 沒有 date，無法平移');
  }
  const oldStartMs = new Date(day1.date + 'T00:00:00Z').getTime();
  const newStartMs = new Date(newStartDate + 'T00:00:00Z').getTime();
  const deltaDays = Math.round((newStartMs - oldStartMs) / MS_PER_DAY);

  if (deltaDays === 0) {
    return json({ ok: true, newStartDate, newEndDate: existing[existing.length - 1]!.date, daysShifted: 0 });
  }

  // Batch UPDATE 所有 days：date += delta, day_of_week 重算
  const stmts: D1PreparedStatement[] = [];
  let newEndDate: string | null = null;
  for (const r of existing) {
    const oldMs = new Date(r.date! + 'T00:00:00Z').getTime();
    const newMs = oldMs + deltaDays * MS_PER_DAY;
    const newDate = new Date(newMs).toISOString().slice(0, 10);
    const newDow = WEEKDAYS[new Date(newMs).getUTCDay()];
    stmts.push(
      db
        .prepare('UPDATE trip_days SET date = ?, day_of_week = ? WHERE id = ?')
        .bind(newDate, newDow, r.id),
    );
    newEndDate = newDate;
  }
  await db.batch(stmts);

  // PR32: audit log for bulk shift（recordId=null + 摘要含 deltaDays + 影響天數）
  await logAudit(db, {
    tripId,
    tableName: 'trip_days',
    recordId: null,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({
      op: 'shift',
      deltaDays,
      daysShifted: existing.length,
      oldStartDate: day1.date,
      newStartDate,
      newEndDate,
    }),
  });

  return json({
    ok: true,
    newStartDate,
    newEndDate,
    daysShifted: existing.length,
  });
};
