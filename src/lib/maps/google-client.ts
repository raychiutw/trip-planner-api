/**
 * google-client.ts — Unified Google Maps Platform API client.
 *
 * Endpoints used:
 *   - Places API (New) v1
 *     - POST /v1/places:searchText        → /api/poi-search
 *     - GET  /v1/places/{place_id}        → Place Details (rating, hours, status)
 *   - Directions API
 *     - POST /v1/directions               → /api/route, /api/trips/[id]/recompute-travel
 *   - Geocoding API
 *     - GET  /maps/api/geocode/json       → /api/geocode (server-side reverse)
 *
 * ## Failure mode (autoplan C2 — no fallback per P11)
 *
 * 任何 upstream failure (timeout / 5xx / parse error / Google quota deny) 一律 throw
 * MAPS_UPSTREAM_FAILED (502)。**NO** OSM / Mapbox / ORS / Haversine fallback。Frontend
 * 顯示 PageErrorState 「服務暫停」+ 重試按鈕。
 *
 * ## Auth
 *
 * Single API key via env GOOGLE_MAPS_API_KEY。Server-side key (X-Goog-Api-Key header).
 * 不 referrer-restrict — 因為從 CF Workers backend 呼叫。Frontend Maps JS 用獨立的
 * GOOGLE_MAPS_BROWSER_KEY (HTTP referrer = trip-planner-dby.pages.dev)。
 *
 * ## Field masks
 *
 * Places API (New) requires X-Goog-FieldMask header to control response shape +
 * billing tier. We use minimal masks per call site to avoid unnecessary cost.
 */
import { AppError } from '../../errors';
import { normalizePoiAddress } from './normalize-address';

const PLACES_BASE = 'https://places.googleapis.com';
const DIRECTIONS_BASE = 'https://routes.googleapis.com';

const TIMEOUT_MS = 8_000;

/** Throw MAPS_UPSTREAM_FAILED with a one-line detail. */
function fail(detail: string): never {
  throw new AppError('MAPS_UPSTREAM_FAILED', detail);
}

/** Google Places business_status enum (3 values per Places API spec). */
export type GoogleBusinessStatus = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    fail(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * v2.33.58 round 12 I5: pre-check apiKey 非空，否則拋 `MAPS_CONFIG` 而非
 * 等 Google 回 401 → 用戶/ops 才能秒辨「設定問題」vs「Google 上游壞」。
 * 所有 exported function entry call 一次。
 */
function requireApiKey(apiKey: string): void {
  if (!apiKey) {
    throw new AppError('MAPS_CONFIG', 'GOOGLE_MAPS_API_KEY 未設定或為空');
  }
}

// ---------------------------------------------------------------------------
// Places API — Search Text
// ---------------------------------------------------------------------------

export interface PlacesSearchTextResult {
  /** Google canonical place id, e.g. "ChIJ..." */
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** Google primary type, e.g. "restaurant" / "tourist_attraction" */
  category: string;
  /** ISO 3166-1 alpha-2 uppercase, e.g. "JP" */
  country?: string;
  /** Country localized name, e.g. "日本" */
  country_name?: string;
  /** Google rating 1-5, optional */
  rating?: number;
  business_status?: GoogleBusinessStatus;
}

/** searchPlacesPage 的回傳：一頁結果 + 下一頁 token（沒有更多則為 null）。 */
export interface PlacesSearchPage {
  results: PlacesSearchTextResult[];
  /** 傳回 searchPlacesPage 的 pageToken 參數即可取下一頁。null = 沒有更多。 */
  nextPageToken: string | null;
}

interface PlacesSearchTextResponse {
  nextPageToken?: string;
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    primaryType?: string;
    addressComponents?: Array<{
      shortText?: string;
      longText?: string;
      types?: string[];
    }>;
    rating?: number;
    businessStatus?: string;
  }>;
}

const SEARCH_TEXT_FIELD_MASK = [
  // ⚠️ Places API (New) **只回 field mask 列出的欄位** —— nextPageToken 不是
  // 自動附帶的。少了這行，分頁永遠拿不到 token（回應照樣 200、20 筆，只是
  // nextPageToken 恆為 null）。單元測試 mock 掉 fetch 直接餵含 token 的假回應，
  // 測不出這點；2026-07-29 靠打真 API 才抓到。
  'nextPageToken',
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.addressComponents',
  'places.rating',
  'places.businessStatus',
].join(',');

/**
 * Places API (New) — POST /v1/places:searchText
 *
 * @param query    自然語言查詢字串（中文 / 英文都 OK，Places 自動 detect）
 * @param region   ISO 3166-1 alpha-2 lowercase 限制搜尋區域，e.g. "jp"
 * @param maxCount 1–20，預設 10
 */
export interface LocationBias {
  /** Center lat in degrees */
  lat: number;
  /** Center lng in degrees */
  lng: number;
  /** Bias circle radius in meters. 0 < r ≤ 50000 per Google API. */
  radiusMeters: number;
}

export async function searchPlacesPage(
  apiKey: string,
  query: string,
  region?: string,
  maxCount = 10,
  locationBias?: LocationBias,
  pageToken?: string,
): Promise<PlacesSearchPage> {
  requireApiKey(apiKey);
  const body: Record<string, unknown> = {
    textQuery: query,
    maxResultCount: Math.min(Math.max(maxCount, 1), 20),
    languageCode: 'zh-TW',
  };
  // 只在有值時放進 body —— 送 `pageToken: undefined` 會被 JSON.stringify 丟掉沒錯，
  // 但顯式條件讓「不分頁」這件事在 request 上看得出來，也擋掉空字串。
  if (pageToken) body.pageToken = pageToken;
  if (region) body.regionCode = region.toLowerCase();
  if (locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: Math.min(Math.max(locationBias.radiusMeters, 1), 50000),
      },
    };
  }

  const res = await fetchWithTimeout(`${PLACES_BASE}/v1/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': SEARCH_TEXT_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`Places searchText ${res.status}`);

  const json = (await res.json().catch(() => null)) as PlacesSearchTextResponse | null;
  if (!json) fail('Places searchText invalid JSON');
  if (!json.places) return { results: [], nextPageToken: json.nextPageToken ?? null };

  const results = json.places
    .filter((p) => p.id && p.location && p.displayName?.text)
    .map((p) => {
      const country = p.addressComponents?.find((c) => c.types?.includes('country'));
      return {
        place_id: p.id,
        name: p.displayName!.text,
        // v2.31.36: normalize Google Places address — collapse doubled admin suffix
        // (號號/縣縣/市市 等 user-submitted typo) + 連續逗號/空白。
        address: normalizePoiAddress(p.formattedAddress) ?? '',
        lat: p.location!.latitude,
        lng: p.location!.longitude,
        category: p.primaryType || '',
        country: country?.shortText?.toUpperCase(),
        country_name: country?.longText,
        rating: p.rating,
        business_status: p.businessStatus as GoogleBusinessStatus | undefined,
      };
    });
  return { results, nextPageToken: json.nextPageToken ?? null };
}

/**
 * 單頁版薄包裝 —— 既有呼叫端（trip import / POI enrich 等）只要結果不要 token，
 * 保持原簽章不動，避免為了分頁去改一票不需要分頁的地方。
 */
export async function searchPlaces(
  apiKey: string,
  query: string,
  region?: string,
  maxCount = 10,
  locationBias?: LocationBias,
): Promise<PlacesSearchTextResult[]> {
  const page = await searchPlacesPage(apiKey, query, region, maxCount, locationBias);
  return page.results;
}

// ---------------------------------------------------------------------------
// Places API — Autocomplete (typeahead for /add-custom-stop, v2.31.94)
// ---------------------------------------------------------------------------

export interface PlacesAutocompletePrediction {
  /** Google canonical place id, e.g. "ChIJ..." */
  placeId: string;
  /** Bold main text (e.g. "高雄市左營區") */
  primaryText: string;
  /** Address tail (e.g. "Kaohsiung City, Taiwan") */
  secondaryText: string;
}

interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
    // queryPrediction etc. filtered out by callers
  }>;
}

const AUTOCOMPLETE_FIELD_MASK = [
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.text',
  'suggestions.placePrediction.structuredFormat',
].join(',');

/**
 * Places API (New) — POST /v1/places:autocomplete
 *
 * Typeahead suggestions for custom-stop UI. Returns placeId + structured text.
 * **Does NOT return lat/lng** — coords resolve via getPlaceDetails on user pick
 * (Google billing pattern: autocomplete + details = one session).
 *
 * @param sessionToken Caller-generated UUID, scoped to one typeahead session
 *                     (rotate on suggestion pick / clear / unmount per Google
 *                     billing semantics — see usePlacesAutocomplete hook).
 * @param regionCode   ISO 3166-1 alpha-2 (case-insensitive, normalized to
 *                     lowercase per existing searchPlaces convention).
 */
export async function autocompletePlaces(
  apiKey: string,
  q: string,
  sessionToken: string,
  regionCode?: string,
): Promise<PlacesAutocompletePrediction[]> {
  requireApiKey(apiKey);
  const body: Record<string, unknown> = {
    input: q,
    sessionToken,
    languageCode: 'zh-TW',
  };
  if (regionCode) body.includedRegionCodes = [regionCode.toLowerCase()];

  const res = await fetchWithTimeout(`${PLACES_BASE}/v1/places:autocomplete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': AUTOCOMPLETE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`Places autocomplete ${res.status}`);

  const json = (await res.json().catch(() => null)) as PlacesAutocompleteResponse | null;
  if (!json) fail('Places autocomplete invalid JSON');
  if (!json.suggestions) return [];

  return json.suggestions
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => Boolean(p && p.placeId))
    .map((p) => ({
      placeId: p.placeId!,
      primaryText:
        p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
      secondaryText: p.structuredFormat?.secondaryText?.text ?? '',
    }));
}

// ---------------------------------------------------------------------------
// Places API — Place Details (lifecycle refresh)
// ---------------------------------------------------------------------------

export interface PlaceDetailsResult {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  business_status: GoogleBusinessStatus;
  /** Open hours weekday descriptions, e.g. ["週一: 11:00 – 22:00", ...] */
  weekday_descriptions?: string[];
  phone?: string;
  /** Google 價位等級 enum（PRICE_LEVEL_INEXPENSIVE…VERY_EXPENSIVE），無則 undefined。 */
  price_level?: string;
}

const PLACE_DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'rating',
  'businessStatus',
  'regularOpeningHours.weekdayDescriptions',
  'internationalPhoneNumber',
  // priceLevel 與 rating/openingHours 同屬 Enterprise SKU — 這個 call 本就
  // Enterprise，加此欄不升 tier（無額外費用）。
  'priceLevel',
].join(',');

/**
 * Places API (New) — GET /v1/places/{place_id}
 *
 * Used by:
 *   - scripts/google-poi-initial-backfill.ts (one-time after migration 0051)
 *   - scripts/google-poi-refresh-30d.ts (daily 30d refresh job)
 *   - tp-* skills via mac mini cron
 *
 * Returns null if Google returns 404 NOT_FOUND（POI delisted from Google Maps）—
 * caller should mark `pois.status = 'missing'`. Throws MAPS_UPSTREAM_FAILED on
 * other errors.
 */
export async function getPlaceDetails(
  apiKey: string,
  placeId: string,
  /**
   * Optional autocomplete session token. When this Place Details call closes a
   * typeahead session, passing the token makes Google count autocomplete +
   * details as **one** billable interaction instead of two (v2.31.94).
   */
  sessionToken?: string,
): Promise<PlaceDetailsResult | null> {
  requireApiKey(apiKey);
  const params = new URLSearchParams({ languageCode: 'zh-TW' });
  if (sessionToken) params.set('sessionToken', sessionToken);
  const res = await fetchWithTimeout(
    `${PLACES_BASE}/v1/places/${encodeURIComponent(placeId)}?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK,
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) fail(`Place details ${res.status}`);

  const json = (await res.json().catch(() => null)) as {
    id?: string;
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    rating?: number;
    businessStatus?: string;
    regularOpeningHours?: { weekdayDescriptions?: string[] };
    internationalPhoneNumber?: string;
    priceLevel?: string;
  } | null;

  if (!json?.id || !json.location || !json.displayName?.text) {
    fail('Place details invalid JSON');
  }

  return {
    place_id: json.id,
    name: json.displayName!.text,
    // v2.31.36: normalize doubled admin suffix typo（同 searchPlaces）
    address: normalizePoiAddress(json.formattedAddress) ?? '',
    lat: json.location!.latitude,
    lng: json.location!.longitude,
    rating: json.rating,
    business_status: (json.businessStatus as GoogleBusinessStatus | undefined) || 'OPERATIONAL',
    weekday_descriptions: json.regularOpeningHours?.weekdayDescriptions,
    phone: json.internationalPhoneNumber,
    price_level: json.priceLevel,
  };
}

// ---------------------------------------------------------------------------
// Routes API — computeRoutes (replaces Mapbox Directions)
// ---------------------------------------------------------------------------

export interface ComputeRouteResult {
  /** Encoded polyline (Google encoded polyline algorithm format) */
  polyline: string;
  /** Total distance in meters */
  distance_meters: number;
  /** Total duration in seconds */
  duration_seconds: number;
}

export type TravelMode = 'DRIVE' | 'WALK' | 'TRANSIT' | 'BICYCLE';

const ROUTES_FIELD_MASK = [
  'routes.polyline.encodedPolyline',
  'routes.distanceMeters',
  'routes.duration',
].join(',');

/**
 * Routes API v2 — POST /directions/v2:computeRoutes
 *
 * Used by:
 *   - /api/route (single from-to)
 *   - /api/trips/[id]/recompute-travel (batch)
 *
 * Throws MAPS_UPSTREAM_FAILED on any failure（NO Haversine fallback per P11/T13）.
 */
export async function computeRoute(
  apiKey: string,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  mode: TravelMode = 'DRIVE',
  /** v2.23.8 self-drive：TRANSIT mode 必須帶 departureTime（ISO 8601 UTC）才有 schedule。
   * DRIVE/WALK 不需，傳了會被 Routes API 拒（only valid for TRANSIT/DRIVE）。 */
  departureTime?: string,
): Promise<ComputeRouteResult> {
  requireApiKey(apiKey);
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    travelMode: mode,
    polylineQuality: 'OVERVIEW',
    computeAlternativeRoutes: false,
    languageCode: 'zh-TW',
    units: 'METRIC',
  };
  if (mode === 'TRANSIT' && departureTime) {
    body.departureTime = departureTime;
  }

  const res = await fetchWithTimeout(`${DIRECTIONS_BASE}/directions/v2:computeRoutes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': ROUTES_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`Routes ${res.status}`);

  const json = (await res.json().catch(() => null)) as {
    routes?: Array<{
      polyline?: { encodedPolyline?: string };
      distanceMeters?: number;
      duration?: string; // e.g. "1234s"
    }>;
  } | null;

  const route = json?.routes?.[0];
  if (!route?.polyline?.encodedPolyline) {
    fail('Routes empty result');
  }

  // v2.23.12: Routes API 對 zero-distance pair（前後 entry 同 lat/lng）回 duration:"0s"
  // 但 *缺* distanceMeters 欄。視為 distance=0 而非 fail，否則「午餐/購物」共用 lat
  // 的 entry 全 error。
  const durationStr = route.duration || '0s';
  const durationSeconds = parseInt(durationStr.replace(/s$/, ''), 10) || 0;

  return {
    polyline: route.polyline!.encodedPolyline!,
    distance_meters: route.distanceMeters ?? 0,
    duration_seconds: durationSeconds,
  };
}

// Geocoding reverse lookup intentionally omitted — add when /api/geocode endpoint ships.
