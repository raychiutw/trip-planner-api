/**
 * GET /api/places/resolve?placeId=...
 *
 * v2.31.94 custom-stop-location-picker: lightweight Place Details wrapper for
 * typeahead pick → map flyTo flow. Closes Google autocomplete session per
 * billing semantics — caller should rotate the sessionToken on the frontend
 * once this returns.
 *
 * Response: { placeId, lat, lng, name, address, hours, priceLevel }
 *   - hours: raw weekday descriptions（\n 分隔），前端 condenseHours 壓縮
 *   - priceLevel: Google 價位 enum，前端映射 ¥ 符號；無則 null
 *
 * Failures:
 *   - missing placeId → 400 DATA_VALIDATION
 *   - getPlaceDetails null (POI delisted) → 404 DATA_NOT_FOUND
 *   - kill switch / upstream → 503 MAPS_LOCKED / 502 MAPS_UPSTREAM_FAILED
 */
import { AppError } from '../../../errors';
import { requireAuth } from '../../../lib/permissions';
import { json } from '../../../lib/utils';
import { assertGoogleAvailable } from '../../../lib/maps-lock';
import { bumpRateLimit } from '../../../lib/rate-limit';
import { getPlaceDetails } from '../../../lib/maps/google-client';
import type { Env } from '../../../env';

// v2.31.94 rate limit: Place Details API is $17/1000 calls (10× autocomplete).
// Per-user cap of 500/24h is generous for legitimate typeahead-pick flow
// (~one resolve per user pick × ~30 picks/trip × ~30 trips/month) but stops
// drain attacks well below kill-switch threshold.
const RATE_LIMIT_CONFIG = {
  maxAttempts: 500,
  windowMs: 24 * 60 * 60 * 1000,
  lockoutMs: 24 * 60 * 60 * 1000,
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const url = new URL(context.request.url);
  const placeId = url.searchParams.get('placeId')?.trim();
  if (!placeId) {
    throw new AppError('DATA_VALIDATION', 'placeId 必填');
  }
  if (placeId.length > 256) {
    throw new AppError('DATA_VALIDATION', 'placeId 過長');
  }
  // v2.31.94: forward optional sessionToken so the autocomplete + this details
  // call count as one billable Google session, not two.
  const sessionTokenRaw = url.searchParams.get('sessionToken')?.trim();
  if (sessionTokenRaw && sessionTokenRaw.length > 128) {
    throw new AppError('DATA_VALIDATION', 'sessionToken 過長');
  }
  const sessionToken = sessionTokenRaw || undefined;

  const apiKey = context.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new AppError('MAPS_UPSTREAM_FAILED', 'GOOGLE_MAPS_API_KEY not configured');
  }

  await assertGoogleAvailable(context.env.DB);

  if (!auth.userId) {
    throw new AppError('AUTH_REQUIRED', 'user session required for places resolve');
  }
  const userKey = `places-resolve:user-${auth.userId}`;
  const limit = await bumpRateLimit(context.env.DB, userKey, RATE_LIMIT_CONFIG);
  if (!limit.ok) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          detail: '已達每日 Place Details 用量上限（500 / 24h），請明日再試',
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

  const details = await getPlaceDetails(apiKey, placeId, sessionToken);
  if (!details) {
    throw new AppError('DATA_NOT_FOUND', 'Google 找不到此景點');
  }

  return json({
    placeId: details.place_id,
    lat: details.lat,
    lng: details.lng,
    name: details.name,
    address: details.address,
    // 2026-07-08 加景點帶入備註：營業時間（raw weekday 行，前端 condenseHours）
    // + 價位 enum（前端映射 ¥ 符號）。訂位 Google 無此欄位 → 不回。
    hours: details.weekday_descriptions?.join('\n') ?? null,
    priceLevel: details.price_level ?? null,
  });
};
