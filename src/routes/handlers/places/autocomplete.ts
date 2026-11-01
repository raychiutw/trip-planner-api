/**
 * POST /api/places/autocomplete — v2.31.94 custom-stop-location-picker
 *
 * Typeahead suggestions for /trip/:id/day/:n/add-custom-stop UI and
 * AddStopPage 自訂 tab. Wraps Google Places API (New) `/v1/places:autocomplete`.
 *
 * Body: { q: string (2-200), sessionToken: string, regionCode?: string }
 * Response: { predictions: Array<{ placeId, primaryText, secondaryText }> }
 *
 * Session token semantics per Google billing: caller (frontend hook) generates
 * a UUID per typeahead session, rotates on suggestion-pick / clear / unmount.
 * One Place Details follow-up call after pick = one billable session.
 *
 * Failure modes:
 *   - kill switch active → 503 MAPS_LOCKED (via assertGoogleAvailable)
 *   - GOOGLE_MAPS_API_KEY missing → 502 MAPS_UPSTREAM_FAILED
 *   - Google upstream 5xx / timeout / parse error → 502 MAPS_UPSTREAM_FAILED
 */
import { AppError } from '../../../errors';
import { requireAuth } from '../../../lib/permissions';
import { json, parseJsonBody } from '../../../lib/utils';
import { assertGoogleAvailable } from '../../../lib/maps-lock';
import { bumpRateLimit } from '../../../lib/rate-limit';
import { autocompletePlaces } from '../../../lib/maps/google-client';
import type { Env } from '../../../env';

// v2.31.94 rate limit: cap per-user typeahead calls to protect Google Maps
// quota from authenticated abuse. 1000 / 24h is generous for legitimate use
// (~30 trips/month × ~30 typeahead calls/trip) but stops `for(;;) fetch(...)`
// authenticated-user drain attacks before the kill switch trips.
const RATE_LIMIT_CONFIG = {
  maxAttempts: 1000,
  windowMs: 24 * 60 * 60 * 1000,
  lockoutMs: 24 * 60 * 60 * 1000,
};

interface AutocompleteBody {
  q?: unknown;
  sessionToken?: unknown;
  regionCode?: unknown;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const body = await parseJsonBody<AutocompleteBody>(context.request);

  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (!q || q.length < 2) {
    throw new AppError('DATA_VALIDATION', 'query (q) 至少 2 個字元');
  }
  if (q.length > 200) {
    throw new AppError('DATA_VALIDATION', 'query (q) 過長（max 200）');
  }

  if (typeof body.sessionToken !== 'string' || !body.sessionToken) {
    throw new AppError('DATA_VALIDATION', 'sessionToken 必填');
  }
  if (body.sessionToken.length > 128) {
    throw new AppError('DATA_VALIDATION', 'sessionToken 過長（max 128）');
  }
  const sessionToken = body.sessionToken;

  const regionCode = typeof body.regionCode === 'string' && body.regionCode
    ? body.regionCode
    : undefined;
  if (regionCode && regionCode.length > 8) {
    throw new AppError('DATA_VALIDATION', 'regionCode 過長（max 8）');
  }

  const apiKey = context.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // Misconfiguration treated as upstream failure — operations sees 502 + alert.
    throw new AppError('MAPS_UPSTREAM_FAILED', 'GOOGLE_MAPS_API_KEY not configured');
  }

  await assertGoogleAvailable(context.env.DB);

  // Per-user daily cap (1000 / 24h). Every call bumps regardless of outcome —
  // even cached / cheap requests count toward the user budget to prevent
  // drain attacks. This endpoint requires a user session (not a service token).
  if (!auth.userId) {
    throw new AppError('AUTH_REQUIRED', 'user session required for places autocomplete');
  }
  const userKey = `places-autocomplete:user-${auth.userId}`;
  const limit = await bumpRateLimit(context.env.DB, userKey, RATE_LIMIT_CONFIG);
  if (!limit.ok) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          detail: '已達每日 typeahead 用量上限（1000 / 24h），請明日再試',
        },
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(limit.retryAfter ?? 3600),
        },
      },
    );
  }

  const predictions = await autocompletePlaces(apiKey, q, sessionToken, regionCode);

  return json({ predictions });
};
