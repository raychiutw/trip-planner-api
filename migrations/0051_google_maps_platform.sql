-- Migration 0051: Google Maps Platform 全套切換 (v2.23.0 google-maps-migration)
--
-- Strategy: forward-only ALTER（columns 對舊 code additive，新 code 用 explicit column lists）
--   - pois: 加 place_id (Google canonical id) + lifecycle 4 cols (status / status_reason /
--           status_checked_at / last_refreshed_at)
--   - pois_search_cache: D1 cache for /api/poi-search Places Text Search results
--   - app_settings: kill switch state (google_maps_locked) + thresholds + future flags
--
-- Rollback policy（design doc §Migration 0051 rollback policy + autoplan T5 fix）:
--   forward-fix only。columns additive 對舊 code 安全 (SELECT 用 explicit column lists)；
--   incident 時 git revert merge commit 即可，**不**執行 DROP COLUMN（D1 SQLite DROP COLUMN
--   對 partial index / CHECK constraint 行為有限，且 forward-fix 比 rollback 快）。
--   若需徹底移除 → 後續 PR 用 swap-table idiom（見 0046/0047 prior art）。
--
-- Deploy 順序（autoplan T7 fix）:
--   1. code deploy（含 usePoiSearch.ts schema guard 改用 place_id）
--   2. wrangler d1 migrations apply tripline-prod --remote (此 migration)
--   3. SSH mac mini → bun run backfill:google（3 天 50/day × 150 POI）
--   中間 1.5-3 天 backfill window 期間，新建 POI 直接走 Phase α Places API 拿 place_id（即時）

-- =============================================
-- 1. pois: 加 place_id + lifecycle fields
-- =============================================
-- place_id nullable — 既有 150 POI backfill 完成前為 NULL；新建 POI 必填。
-- status DEFAULT 'active' + CHECK constraint：保證 enum 三值。
-- 與 OSM osm_id 並存：osm_id 在 Phase β 同 PR drop（src/types/poi.ts + usePoiSearch
-- schema guard 改用 place_id），但 D1 schema 保留 osm_id column 作 forward-fix safety
-- net（不 DROP COLUMN）。

ALTER TABLE pois ADD COLUMN place_id           TEXT;
ALTER TABLE pois ADD COLUMN status             TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'closed', 'missing'));
ALTER TABLE pois ADD COLUMN status_reason      TEXT;       -- 「永久歇業」/「Google Maps 查無資料」
ALTER TABLE pois ADD COLUMN status_checked_at  TEXT;       -- ISO timestamp; 最後一次 Place Details fetch
ALTER TABLE pois ADD COLUMN last_refreshed_at  TEXT;       -- ISO timestamp; 30d refresh job 排程鍵

-- =============================================
-- 2. pois indexes — place_id lookup + refresh scheduling + status filter
-- =============================================
-- idx_pois_place_id: PoiSearch result → 找既有 POI（避免重複 INSERT 同個 Google place）
-- idx_pois_refresh_due: 30d refresh job 用；partial index status='active' + 含 place_id
--   作 covering index；refresh query 用「last_refreshed_at IS NULL OR < now-30d」，所以
--   index 順序 (last_refreshed_at, place_id) 讓 ASC NULLS FIRST 排序拿出最舊的先 refresh。
-- idx_pois_status: badge / health endpoint 用；partial index status != 'active' 只 index
--   少數 closed/missing rows，rare path 但查詢頻率高（每次 trip render）。

CREATE INDEX idx_pois_place_id    ON pois(place_id);
CREATE INDEX idx_pois_refresh_due ON pois(last_refreshed_at, place_id) WHERE status = 'active';
CREATE INDEX idx_pois_status      ON pois(status) WHERE status != 'active';

-- =============================================
-- 3. pois_search_cache — Google Places Text Search 24h cache
-- =============================================
-- query_hash: SHA-256 of normalized query + region (lowercase + trim + nfd-normalize)
-- results_json: TEXT (raw Places API response, parsed at read time)
-- expires_at: fetched_at + 24h, MUST 比較才 hit
-- Index on expires_at: cleanup job (daily-check) DELETE WHERE expires_at < now()

CREATE TABLE pois_search_cache (
  query_hash   TEXT PRIMARY KEY,
  query_text   TEXT NOT NULL,
  region       TEXT,                                                     -- ISO 3166-1 alpha-2 (JP/TW/KR), nullable
  results_json TEXT NOT NULL,
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL                                             -- fetched_at + 24h, set by app
);

CREATE INDEX idx_pois_search_cache_expires ON pois_search_cache(expires_at);

-- =============================================
-- 4. app_settings — kill switch state + thresholds (autoplan T6/T11/C4 fix)
-- =============================================
-- key/value pairs；單表多用途避免每次新 setting 加 column。
-- updated_at + updated_by + note：audit trail；admin endpoint 改 setting 寫這 3 欄。
-- read frequency 高（每 /api/poi-search /api/route 都讀 google_maps_locked）→ application
-- 層 cache 10s（autoplan T6 fix），每 11s 重讀 D1 + 比 updated_at unchanged 則保留 cache。

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,                                                       -- email or 'system:google-quota-monitor'
  note       TEXT
);

-- INSERT OR IGNORE so re-apply (test fixture re-init / incident recovery) is idempotent.
-- google_maps_migration_applied_at sentinel reflects FIRST apply only — desired for backfill scheduling.
INSERT OR IGNORE INTO app_settings (key, value, note) VALUES
  ('google_maps_locked',                'false',  'set to true by daily-check at MTD over 90 percent of free credit'),
  ('google_maps_locked_reason',         '',       'human-readable reason e.g. MTD 182.30 of 200'),
  ('google_maps_locked_at',             '',       'ISO timestamp of lock'),
  ('google_maps_budget_usd',            '200',    'monthly free credit (review monthly)'),
  ('google_maps_lock_threshold_pct',    '90',     'lock at MTD over N percent of budget'),
  ('google_maps_unlock_threshold_pct',  '50',     'unlock at MTD under N percent of budget (hysteresis prevents flapping)'),
  ('google_maps_migration_applied_at',  datetime('now'), 'migration 0051 apply time + backfill scheduling sentinel');

-- =============================================
-- 5. ANALYZE — refresh query planner stats
-- =============================================

ANALYZE pois;
ANALYZE pois_search_cache;
ANALYZE app_settings;
