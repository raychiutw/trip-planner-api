/**
 * City / region → locationBias circle (lat/lng + radius) for Google Places
 * Text Search.
 *
 * v2.23.4 hotfix：v2.23.3 試過 `regionCode` 但 Google API doc 寫明「only affects
 * ranking, does not restrict」— 實測 region=JP + q=拉麵 在台灣 IP 還是吐 5 筆台
 * 灣拉麵店。城市級 bias 必須走 `locationBias { circle: { center, radius } }`。
 *
 * Returns undefined for "全部地區" / unknown user-typed region — fallback to
 * caller-IP geolocation（accepted legacy behaviour）。
 */

export interface LocationBiasCircle {
  /** ISO 3166-1 alpha-2 country code，給 regionCode 一起傳，formatting 用。 */
  countryCode: string;
  lat: number;
  lng: number;
  /** Bias circle radius in meters. Must be 0 < r ≤ 50000 per Google API. */
  radiusMeters: number;
}

const CITY_BIAS: Record<string, LocationBiasCircle> = {
  // Japan
  '沖繩':   { countryCode: 'JP', lat: 26.2124, lng: 127.6792, radiusMeters: 50000 },
  '那霸':   { countryCode: 'JP', lat: 26.2124, lng: 127.6792, radiusMeters: 30000 },
  '東京':   { countryCode: 'JP', lat: 35.6762, lng: 139.6503, radiusMeters: 35000 },
  '京都':   { countryCode: 'JP', lat: 35.0116, lng: 135.7681, radiusMeters: 25000 },
  '大阪':   { countryCode: 'JP', lat: 34.6937, lng: 135.5023, radiusMeters: 30000 },
  '北海道': { countryCode: 'JP', lat: 43.0642, lng: 141.3469, radiusMeters: 50000 },
  '札幌':   { countryCode: 'JP', lat: 43.0642, lng: 141.3469, radiusMeters: 30000 },
  '福岡':   { countryCode: 'JP', lat: 33.5904, lng: 130.4017, radiusMeters: 25000 },
  '名古屋': { countryCode: 'JP', lat: 35.1815, lng: 136.9066, radiusMeters: 25000 },
  '橫濱':   { countryCode: 'JP', lat: 35.4437, lng: 139.6380, radiusMeters: 25000 },
  '神戶':   { countryCode: 'JP', lat: 34.6901, lng: 135.1955, radiusMeters: 25000 },
  // Korea
  '首爾':     { countryCode: 'KR', lat: 37.5665, lng: 126.9780, radiusMeters: 35000 },
  '釜山':     { countryCode: 'KR', lat: 35.1796, lng: 129.0756, radiusMeters: 30000 },
  '濟州':     { countryCode: 'KR', lat: 33.4996, lng: 126.5312, radiusMeters: 50000 },
  '濟州島':   { countryCode: 'KR', lat: 33.4996, lng: 126.5312, radiusMeters: 50000 },
  // Taiwan
  '台北':   { countryCode: 'TW', lat: 25.0330, lng: 121.5654, radiusMeters: 25000 },
  '台中':   { countryCode: 'TW', lat: 24.1477, lng: 120.6736, radiusMeters: 25000 },
  '台南':   { countryCode: 'TW', lat: 22.9999, lng: 120.2270, radiusMeters: 20000 },
  '高雄':   { countryCode: 'TW', lat: 22.6273, lng: 120.3014, radiusMeters: 25000 },
  '花蓮':   { countryCode: 'TW', lat: 23.9871, lng: 121.6015, radiusMeters: 30000 },
  '台東':   { countryCode: 'TW', lat: 22.7613, lng: 121.1438, radiusMeters: 30000 },
  '宜蘭':   { countryCode: 'TW', lat: 24.7021, lng: 121.7378, radiusMeters: 25000 },
  // Hong Kong / Macau
  '香港':   { countryCode: 'HK', lat: 22.3193, lng: 114.1694, radiusMeters: 25000 },
  '澳門':   { countryCode: 'MO', lat: 22.1987, lng: 113.5439, radiusMeters: 15000 },
  // Southeast Asia
  '曼谷':       { countryCode: 'TH', lat: 13.7563, lng: 100.5018, radiusMeters: 30000 },
  '清邁':       { countryCode: 'TH', lat: 18.7883, lng: 98.9853, radiusMeters: 25000 },
  '新加坡':     { countryCode: 'SG', lat: 1.3521, lng: 103.8198, radiusMeters: 25000 },
  '吉隆坡':     { countryCode: 'MY', lat: 3.1390, lng: 101.6869, radiusMeters: 30000 },
  '河內':       { countryCode: 'VN', lat: 21.0285, lng: 105.8542, radiusMeters: 25000 },
  '胡志明市':   { countryCode: 'VN', lat: 10.8231, lng: 106.6297, radiusMeters: 30000 },
  '峇里島':     { countryCode: 'ID', lat: -8.4095, lng: 115.1889, radiusMeters: 50000 },
  '巴里島':     { countryCode: 'ID', lat: -8.4095, lng: 115.1889, radiusMeters: 50000 },
  '馬尼拉':     { countryCode: 'PH', lat: 14.5995, lng: 120.9842, radiusMeters: 30000 },
  '宿霧':       { countryCode: 'PH', lat: 10.3157, lng: 123.8854, radiusMeters: 30000 },
};

/**
 * Resolve user-facing region label (中文 city name) to a Google Places
 * locationBias circle. Returns undefined for "全部地區" or unrecognised input.
 */
export function regionToLocationBias(region: string | null | undefined): LocationBiasCircle | undefined {
  if (!region) return undefined;
  if (region === '全部地區') return undefined;
  return CITY_BIAS[region.trim()];
}

/**
 * Legacy helper kept for backward compat — v2.23.3 only resolved to ISO
 * country code. Now delegates to locationBias and returns the country code
 * field. New code should call `regionToLocationBias` directly.
 *
 * @deprecated v2.33.38 — no production caller remains (verified by grep).
 *   Kept solely to satisfy `tests/unit/region-to-country-code.test.ts`. New
 *   code should call `regionToLocationBias(region)?.countryCode` directly.
 */
export function regionToCountryCode(region: string | null | undefined): string | undefined {
  return regionToLocationBias(region)?.countryCode;
}

/**
 * Frontend → API param normaliser. Send the raw city name (中文) so the API
 * can build a city-level locationBias circle. Returns undefined for empty /
 * "全部地區" so the URL omits `&region=`.
 */
export function regionToApiParam(region: string | null | undefined): string | undefined {
  if (!region) return undefined;
  const trimmed = region.trim();
  if (!trimmed || trimmed === '全部地區') return undefined;
  return trimmed;
}
