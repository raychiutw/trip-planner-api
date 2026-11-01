/**
 * /api/trips/:id/shares/:shareId — manage a single share link (v2.39.0 + v2.40.x).
 *   PATCH { action: 'revoke' }                          → close the link (keeps analytics).
 *   PATCH { action: 'rotate' }                          → NEW token (returned ONCE); old URL 404s.
 *   PATCH { action: 'update', visibleSections?, label?, → edit visible sections / label /
 *           expiresAt?, anonymous? }                       expiry / anonymous WITHOUT a new URL.
 *   DELETE                                              → remove the link entirely.
 *
 * rotate + update only affect ACTIVE links (revoked_at IS NULL AND not expired) — a
 * revoked link is never silently resurrected and an expired one can't be edited/rotated
 * (create a fresh link). IDOR defence (S6): every op binds `AND trip_id = ?` + affected-
 * rows = 1, else 404. Auth re-checked live.
 */
import { requireAuth, requireTripWrite } from '../../../../../lib/permissions';
import { AppError } from '../../../../../errors';
import { json } from '../../../../../lib/utils';
import { generateShareToken, hashToken, sanitizeVisibleSections, validateExpiresAt } from '../../../../../lib/share';
import type { Env } from '../../../../../env';

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const { id, shareId } = context.params as { id: string; shareId: string };
  const db = context.env.DB;
  await requireTripWrite(db, requireAuth(context), id);
  const body = (await context.request.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.action === 'revoke') {
    const res = await db
      .prepare("UPDATE trip_shares SET revoked_at = datetime('now') WHERE id = ? AND trip_id = ? AND revoked_at IS NULL")
      .bind(shareId, id)
      .run();
    if (!res.meta.changes) throw new AppError('DATA_NOT_FOUND'); // wrong trip / already revoked / gone
    return json({ ok: true, revoked: true });
  }

  if (body.action === 'rotate') {
    // New token (returned once). Only ACTIVE links rotate — a revoked link must NOT be
    // silently resurrected, and an expired link would mint a dead-on-arrival token; both
    // 404 so the owner creates a fresh link instead. UNIQUE retry.
    const now = Date.now();
    for (let attempt = 0; ; attempt++) {
      const token = generateShareToken();
      const tokenHash = await hashToken(token);
      try {
        const res = await db
          .prepare('UPDATE trip_shares SET token_hash = ? WHERE id = ? AND trip_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
          .bind(tokenHash, shareId, id, now)
          .run();
        if (!res.meta.changes) throw new AppError('DATA_NOT_FOUND'); // wrong trip / revoked / expired
        return json({ ok: true, token, url: `/s/${token}` });
      } catch (e) {
        if (e instanceof AppError) throw e;
        if (attempt >= 2 || !/UNIQUE/i.test(String(e))) throw e;
      }
    }
  }

  if (body.action === 'update') {
    // Edit visible sections / label / expiry / anonymous WITHOUT issuing a new URL.
    // Only ACTIVE links (consistent with rotate); column names are hardcoded literals
    // (no injection), values bound + sanitised.
    const now = Date.now();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (Array.isArray(body.visibleSections)) {
      sets.push('visible_sections = ?');
      binds.push(JSON.stringify(sanitizeVisibleSections(body.visibleSections)));
    }
    if (typeof body.label === 'string') {
      sets.push('label = ?');
      binds.push(body.label.trim().slice(0, 80));
    }
    if ('expiresAt' in body) {
      sets.push('expires_at = ?');
      binds.push(validateExpiresAt(body.expiresAt)); // null clears (= never)
    }
    if (typeof body.anonymous === 'boolean') {
      sets.push('anonymous = ?');
      binds.push(body.anonymous ? 1 : 0);
    }
    if (sets.length === 0) throw new AppError('DATA_VALIDATION');
    binds.push(shareId, id, now);
    const res = await db
      .prepare(`UPDATE trip_shares SET ${sets.join(', ')} WHERE id = ? AND trip_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(...binds)
      .run();
    if (!res.meta.changes) throw new AppError('DATA_NOT_FOUND'); // wrong trip / revoked / expired
    return json({ ok: true, updated: true });
  }

  throw new AppError('DATA_VALIDATION');
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { id, shareId } = context.params as { id: string; shareId: string };
  const db = context.env.DB;
  await requireTripWrite(db, requireAuth(context), id);

  const res = await db
    .prepare('DELETE FROM trip_shares WHERE id = ? AND trip_id = ?')
    .bind(shareId, id)
    .run();
  if (!res.meta.changes) throw new AppError('DATA_NOT_FOUND');
  return json({ ok: true, deleted: true });
};
