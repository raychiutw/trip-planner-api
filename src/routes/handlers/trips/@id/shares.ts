/**
 * /api/trips/:id/shares — owner/co-editor share-link management (v2.39.0).
 *   GET  → list this trip's share links (NO token / token_hash ever returned).
 *   POST → create a new share link; returns the raw token ONCE (only chance to copy).
 *
 * Auth: requireAuth + requireTripWrite(tripId) — re-checked LIVE on every call
 * (never trusts created_by as a standing grant). PR2 adds PATCH section/expiry edits;
 * revoke/delete live in shares/[shareId].ts.
 */
import { requireAuth, requireTripWrite } from '../../../../lib/permissions';
import { AppError } from '../../../../errors';
import { json } from '../../../../lib/utils';
import {
  generateShareToken,
  hashToken,
  sanitizeVisibleSections,
  validateExpiresAt,
  DEFAULT_SHARE_SECTIONS,
} from '../../../../lib/share';
import type { Env } from '../../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { id } = context.params as { id: string };
  const db = context.env.DB;
  // Intentional: listing/managing share links is a WRITE-tier capability — a viewer
  // collaborator (read-only) cannot see or manage links. Do NOT relax to hasPermission.
  await requireTripWrite(db, requireAuth(context), id);

  // Includes revoked-but-not-deleted rows so retained view_count analytics stay reachable.
  const { results } = await db
    .prepare(
      `SELECT id, label, visible_sections, expires_at, view_count, anonymous, created_by, created_at, revoked_at
       FROM trip_shares WHERE trip_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .bind(id)
    .all();
  return json({ shares: results ?? [] });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { id } = context.params as { id: string };
  const db = context.env.DB;
  const auth = requireAuth(context);
  await requireTripWrite(db, auth, id);

  const body = (await context.request.json().catch(() => ({}))) as Record<string, unknown>;
  const visible = sanitizeVisibleSections(
    Array.isArray(body.visibleSections) ? body.visibleSections : DEFAULT_SHARE_SECTIONS,
  );
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
  const expiresAt = validateExpiresAt(body.expiresAt);
  const anonymous = body.anonymous === true ? 1 : 0;

  // INSERT with UNIQUE(token_hash) collision retry (astronomically rare; defensive).
  for (let attempt = 0; ; attempt++) {
    const token = generateShareToken();
    const tokenHash = await hashToken(token);
    try {
      const row = await db
        .prepare(
          `INSERT INTO trip_shares (trip_id, token_hash, label, visible_sections, expires_at, anonymous, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(id, tokenHash, label, JSON.stringify(visible), expiresAt, anonymous, auth.userId ?? '')
        .first<{ id: number }>();
      if (!row?.id) throw new AppError('SYS_DB_ERROR', '建立分享連結失敗');
      // raw token returned ONCE — only the hash is persisted.
      return json({
        id: row.id,
        token,
        url: `/s/${token}`,
        label,
        visibleSections: visible,
        expiresAt,
        anonymous,
      });
    } catch (e) {
      // Only the astronomically-rare UNIQUE(token_hash) collision is retriable;
      // any other failure (FK gone, transient D1) must surface, not silently retry.
      if (attempt >= 2 || !/UNIQUE/i.test(String(e))) throw e;
    }
  }
};
