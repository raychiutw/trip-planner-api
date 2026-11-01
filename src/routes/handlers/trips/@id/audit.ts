
import { AppError } from '../../../../errors';
import { requireAuth, requireTripWrite } from '../../../../lib/permissions';
import { json } from '../../../../lib/utils';
import type { Env } from '../../../../env';

// GET /api/trips/:id/audit
// Query params: limit (default 20), request_id (optional filter)
// Auth: per-trip owner/member（requireTripWrite；Phase 3 移除全域 admin）
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const { id } = context.params as { id: string };
  const db = context.env.DB;
  // Phase 1（移除全域 admin / D4）：audit 歷史改 per-trip owner gate（owner/member 可看自己 trip）。
  await requireTripWrite(db, auth, id);

  const url = new URL(context.request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || '20'), 100));
  const requestId = url.searchParams.get('request_id');

  let sql = 'SELECT * FROM audit_log WHERE trip_id = ?';
  const params: (string | number)[] = [id];

  if (requestId) {
    const rid = Number(requestId);
    if (!Number.isFinite(rid) || rid < 1) {
      throw new AppError('DATA_VALIDATION', 'request_id must be a positive integer');
    }
    sql += ' AND request_id = ?';
    params.push(rid);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const { results } = await db.prepare(sql).bind(...params).all();
  return json(results);
};
