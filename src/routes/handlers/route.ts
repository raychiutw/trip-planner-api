/**
 * GET /api/route?from=lng,lat&to=lng,lat
 *
 * v2.23.0 google-maps-migration: Mapbox Directions → Google Routes API.
 * **NO** Haversine fallback per P11/T13 — failure → 502 MAPS_UPSTREAM_FAILED.
 * Frontend `<PageErrorState>` 顯示「服務暫停」+ 重試。
 *
 * Response: { polyline: [[lat, lng], ...], duration: seconds, distance: meters }
 *   polyline 已 decode（Google encoded polyline → flat lat/lng pairs）以對齊既有
 *   Leaflet/useRoute 客戶端解碼預期。frontend 僅渲染 lat/lng 直接 plot。
 *
 * Failure semantics:
 *   - kill switch active → 503 MAPS_LOCKED
 *   - GOOGLE_MAPS_API_KEY missing → 502 (operations sees + alert)
 *   - Google upstream timeout / 5xx / parse error → 502 MAPS_UPSTREAM_FAILED
 */

import { AppError, buildRateLimitResponse } from '../../errors';
import { assertGoogleAvailable } from '../../lib/maps-lock';
import { bumpRateLimit, clientIp, RATE_LIMITS } from '../../lib/rate-limit';
import { computeRoute } from '../../lib/maps/google-client';
import type { Env } from '../../env';

interface Coord { lng: number; lat: number; }

function parseCoord(raw: string | null): Coord | null {
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return { lng, lat };
}

/**
 * Decode Google encoded polyline (https://developers.google.com/maps/documentation/utilities/polylinealgorithm).
 * Returns flat array of [lat, lng] tuples for direct Leaflet/Google Maps Polyline render.
 */
function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const from = parseCoord(url.searchParams.get('from'));
  const to = parseCoord(url.searchParams.get('to'));
  if (!from || !to) {
    throw new AppError('DATA_VALIDATION', 'from/to must be lng,lat within range');
  }

  // v2.33.42 security audit: per-IP rate limit — public anonymous endpoint
  // 直接打 Google Routes API ($5/1000)，無限制會被 attacker 拉爆 quota。
  const ip = clientIp(context.request);
  const rl = await bumpRateLimit(context.env.DB, `route:ip:${ip}`, RATE_LIMITS.ROUTE_PER_IP);
  if (!rl.ok) {
    return buildRateLimitResponse(rl.retryAfter ?? 60, { error: { code: 'RATE_LIMITED', message: '請求過於頻繁，請稍後再試' } });
  }

  const apiKey = context.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new AppError('MAPS_UPSTREAM_FAILED', 'GOOGLE_MAPS_API_KEY not configured');
  }

  await assertGoogleAvailable(context.env.DB);

  const result = await computeRoute(apiKey, { lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, 'DRIVE');

  const polyline = decodePolyline(result.polyline);

  return new Response(
    JSON.stringify({
      polyline,
      duration: result.duration_seconds,
      distance: result.distance_meters,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400',
      },
    },
  );
};
