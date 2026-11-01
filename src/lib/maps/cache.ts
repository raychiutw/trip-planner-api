/**
 * cache.ts — D1 cache wrapper for Google Places Text Search.
 *
 * Cache TTL 24h（design doc P8）。Identical (query + region) within 24h hits cache
 * → 不消耗 Places API quota。
 *
 * Cache key = SHA-256 hex of normalized "query|region"（lowercase + trim + nfd-normalize）.
 * Avoids collisions between Chinese variants（簡 vs 繁）+ whitespace differences.
 *
 * Cleanup：daily-check 跑 `DELETE FROM pois_search_cache WHERE expires_at < now()`
 * 對應 idx_pois_search_cache_expires partial index。
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { PlacesSearchTextResult } from './google-client';

const TTL_HOURS = 24;

/**
 * SHA-256 cache key from normalized query string.
 * NFD-normalize collapses 「壽司」/「寿司」 variants; trim + lowercase removes whitespace bias.
 */
async function buildKey(query: string, region?: string): Promise<string> {
  const normalized = `${query.normalize('NFD').toLowerCase().trim()}|${region?.toLowerCase() || ''}`;
  const buf = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Read cached search results. Returns null on miss / expired / parse error.
 */
export async function getCachedSearch(
  db: D1Database,
  query: string,
  region: string | undefined,
): Promise<PlacesSearchTextResult[] | null> {
  // 兩個 await 串行：bind(key) depends on buildKey 結果，不能 parallel。
  // RBP-18 async-defer-await 不適用此 dependent chain。
  const key = await buildKey(query, region);
  const row = await db
    .prepare(
      `SELECT results_json FROM pois_search_cache
       WHERE query_hash = ? AND expires_at > datetime('now')`,
    )
    .bind(key)
    .first<{ results_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.results_json) as PlacesSearchTextResult[];
  } catch {
    return null;
  }
}

/**
 * Write search results to cache. Upsert on query_hash collision (refresh TTL).
 */
export async function setCachedSearch(
  db: D1Database,
  query: string,
  region: string | undefined,
  results: PlacesSearchTextResult[],
): Promise<void> {
  const key = await buildKey(query, region);
  // SQLite-native 'YYYY-MM-DD HH:MM:SS' (not ISO) — the read/cleanup queries
  // compare against datetime('now'); an ISO 'T'/'.SSSZ' string sorts lexically
  // greater than the space-format, so ISO rows would never expire intra-day.
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  await db
    .prepare(
      `INSERT INTO pois_search_cache (query_hash, query_text, region, results_json, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(query_hash) DO UPDATE SET
         results_json = excluded.results_json,
         fetched_at = datetime('now'),
         expires_at = excluded.expires_at`,
    )
    .bind(key, query, region || null, JSON.stringify(results), expiresAt)
    .run();
}

/**
 * Delete expired cache rows. Called by daily-check.
 * Returns number of rows deleted.
 */
export async function cleanupExpiredCache(db: D1Database): Promise<number> {
  const r = await db
    .prepare(`DELETE FROM pois_search_cache WHERE expires_at < datetime('now')`)
    .run();
  return r.meta.changes || 0;
}
