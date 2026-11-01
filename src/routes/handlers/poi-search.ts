/**
 * GET /api/poi-search?q=<query>&region=<JP|TW|KR>&limit=<n>
 *
 * v2.23.0 google-maps-migration: 改打 Google Places Text Search (replaces OSM Nominatim).
 * D1 cache 24h（pois_search_cache table）— identical (query+region) within 24h hits cache.
 *
 * Response: { results: Array<{ place_id, name, address, lat, lng, category, country, country_name }> }
 *
 * Failures: any Google upstream error → 502 MAPS_UPSTREAM_FAILED (no fallback per P11).
 *           kill switch active → 503 MAPS_LOCKED.
 *
 * Cache-Control: private, max-age=300 — 短 edge cache 因為 D1 cache 24h，edge 5min 即可。
 */
import { AppError, buildRateLimitResponse } from '../../errors';
import { assertGoogleAvailable } from '../../lib/maps-lock';
import { bumpRateLimit, clientIp, RATE_LIMITS } from '../../lib/rate-limit';
import { searchPlacesPage, type PlacesSearchTextResult } from '../../lib/maps/google-client';
import { getCachedSearch, setCachedSearch } from '../../lib/maps/cache';
import { regionToLocationBias } from '../../lib/maps/region';
import type { Env } from '../../env';

export type PoiSearchResult = PlacesSearchTextResult;

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const q = url.searchParams.get('q')?.trim();
  const regionRaw = url.searchParams.get('region')?.trim() || undefined;
  // 兼容 v2.23.3：region 可能是 ISO code (e.g. "JP") 或 city 中文 ("東京")。
  // city 中文 → locationBias circle（強制 city-level bias）；ISO → regionCode only（弱 ranking 提示）
  const cityBias = regionToLocationBias(regionRaw);
  const region = cityBias?.countryCode ?? regionRaw?.toUpperCase();
  // Cache key 必須用 raw city 字串（"東京"/"沖繩"），不能 normalize 成 ISO，
  // 否則「東京」/「沖繩」共用同一 cache row 撞 v2.23.3 殘留資料（都歸 JP）。
  const cacheKey = regionRaw ?? region;
  const limitParam = url.searchParams.get('limit');
  const pageToken = url.searchParams.get('pageToken') || undefined;

  if (!q || q.length < 2) {
    throw new AppError('DATA_VALIDATION', 'query (q) 至少 2 個字元');
  }
  if (q.length > 200) {
    throw new AppError('DATA_VALIDATION', 'query (q) 過長（max 200）');
  }
  const limit = Math.min(Math.max(parseInt(limitParam ?? '10', 10) || 10, 1), 20);

  // v2.33.42 security audit: per-IP rate limit — public anonymous proxy 直接打
  // Google Places Text Search ($32/1000)，cache miss 唯一鎖。auth'd users 走
  // autocomplete 已有 1000/24h；本 endpoint 給 search box 用，200/24h/IP 夠。
  const ip = clientIp(context.request);
  const rl = await bumpRateLimit(context.env.DB, `poi-search:ip:${ip}`, RATE_LIMITS.POI_SEARCH_PER_IP);
  if (!rl.ok) {
    return buildRateLimitResponse(rl.retryAfter ?? 60, { error: { code: 'RATE_LIMITED', message: '搜尋過於頻繁，請稍後再試' } });
  }

  const apiKey = context.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // Misconfiguration is treated as upstream failure — operations sees 502 + alert.
    throw new AppError('MAPS_UPSTREAM_FAILED', 'GOOGLE_MAPS_API_KEY not configured');
  }

  await assertGoogleAvailable(context.env.DB);

  // D1 cache 只服務第一頁。cache key 是 (q, region)，第 2/3 頁的結果內容完全不同，
  // 讀或寫同一個 key 都會讓之後的首次搜尋拿到中間頁 —— 所以有 pageToken 時
  // 整個 cache 路徑跳過（不讀也不寫）。
  if (!pageToken) {
    const cached = await getCachedSearch(context.env.DB, q, cacheKey);
    if (cached) {
      return jsonResponse(
        // 命中快取時沒有 token 可給 —— 快取只存第一頁，續頁得靠 cache miss 那條路。
        { results: cached.slice(0, limit), nextPageToken: null },
        200,
        { 'Cache-Control': 'private, max-age=300', 'X-Cache': 'HIT' },
      );
    }
  }

  const page = await searchPlacesPage(apiKey, q, region, limit, cityBias, pageToken);

  // Fire-and-forget cache write — don't block response。同上：只快取第一頁。
  if (!pageToken) {
    context.waitUntil(setCachedSearch(context.env.DB, q, cacheKey, page.results));
  }

  return jsonResponse(
    { results: page.results, nextPageToken: page.nextPageToken },
    200,
    { 'Cache-Control': 'private, max-age=300', 'X-Cache': 'MISS' },
  );
};
