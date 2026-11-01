/**
 * Geo helpers — pure math, shared client + server.
 *
 * Canonical location for haversine + LatLng + region heuristics. Server
 * (recompute-travel) + client (TimelineRail stale-travel / EditEntryPage
 * cross-region warning) share this to avoid drift.
 *
 * Haversine 大圓距離（公尺）平均地球半徑 IUGG mean 6,371,008.8 m。
 * 對 trip-planner 距離尺度（同城 ~ 跨日本）誤差 < 0.5%。
 */

const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng { lat: number; lng: number }

export function haversineMeters(a: LatLng, b: LatLng): number {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLambda = ((b.lng - a.lng) * Math.PI) / 180;

  const x =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));

  return EARTH_RADIUS_M * c;
}

/** 點集合的算術平均座標（empty → null）。 */
export function avgLatLng(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let sumLat = 0; let sumLng = 0;
  for (const p of points) { sumLat += p.lat; sumLng += p.lng; }
  return { lat: sumLat / points.length, lng: sumLng / points.length };
}

/**
 * Cross-region warning threshold（公尺）— 沖繩本島南北 ~120 km，城市內 ~10 km，
 * 跨日本 1500+ km。多日 trip 同日內超過此距離多半是 swap 錯人。
 */
export const CROSS_REGION_THRESHOLD_M = 50_000;
