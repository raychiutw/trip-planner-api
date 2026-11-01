/**
 * GET /api/share/:token — PUBLIC (no-auth) trip share view (v2.39.0).
 *
 * Middleware (_middleware.ts) bypasses auth for GET /api/share/*. Security is the
 * token itself (CSPRNG ≥192-bit, stored as hash) + this handler:
 *  - resolveActiveShare returns a uniform null for not-found / revoked / expired →
 *    one 404 for all (no enumeration oracle); junk tokens are pre-filtered.
 *  - loadVisibleShareData is the single DEFAULT-DENY filtered source (closed note
 *    sections are never queried; no owner PII in the payload).
 *  - per-IP rate limit (paid-quota + view-count write-amplification DoS guard).
 *  - view_count is atomic + AFTER the response in waitUntil (no latency / oracle).
 *  - headers: no-store / no-referrer / frame DENY / nosniff.
 *
 * Returns the raw {meta, days, notes} shape (deep-camelled by json()); the client
 * maps it with the shared mapRawToPrintData (reusing toTimelineEntry).
 */
import { resolveActiveShare, loadVisibleShareData } from '../../../lib/share';
import { checkRateLimit, bumpRateLimit, clientIp, RATE_LIMITS } from '../../../lib/rate-limit';
import { json } from '../../../lib/utils';
import type { Env } from '../../../env';

const SHARE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};

function withShareHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SHARE_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function notFound(): Response {
  return withShareHeaders(
    new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { token } = context.params as { token: string };
  const db = context.env.DB;
  const ip = clientIp(context.request);
  const bucket = `share-view:${ip}`;

  const rl = await checkRateLimit(db, bucket, RATE_LIMITS.SHARE_VIEW_PER_IP);
  if (!rl.ok) {
    return withShareHeaders(
      new Response(JSON.stringify({ error: 'RATE_LIMIT' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter ?? 3600) },
      }),
    );
  }
  // Count every request (hit OR miss) so token-scanning + refresh-flood throttle.
  context.waitUntil(bumpRateLimit(db, bucket, RATE_LIMITS.SHARE_VIEW_PER_IP).then(() => undefined));

  const share = await resolveActiveShare(db, token);
  if (!share) return notFound();

  const payload = await loadVisibleShareData(db, share);

  // Atomic view_count++ AFTER building the response (no read-modify-write race,
  // no added latency, not an active-vs-404 timing signal).
  context.waitUntil(
    db.prepare('UPDATE trip_shares SET view_count = view_count + 1 WHERE id = ?').bind(share.id).run().then(() => undefined),
  );

  return withShareHeaders(json(payload));
};
