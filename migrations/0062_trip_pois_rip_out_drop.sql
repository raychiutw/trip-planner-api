-- Migration 0062: trip_pois rip-out phase 3 — DROP cols + DROP table
--
-- ## Background
--
-- 接續 migration 0061。Backfill 完成，舊資料全進新表，此 migration 拆掉 legacy structure。
--
-- ## Scope
--
-- 1. trip_entries DROP 8 cols：time / poi_id / 6 travel_*
-- 2. trip_destinations DROP 2 cols：osm_id / osm_type
-- 3. DROP TABLE trip_pois
--
-- ## Deploy 順序（hard rule）
--
-- 必須最後 apply（順序：0060 → backend deploy → wait → 0061 → 0062）。
-- 此檔 apply 前 backend 必須完成 cutover：
--   - 不再讀寫 trip_entries.{time, poi_id, travel_*}
--   - 不再 INSERT trip_destinations.osm_*
--   - 不再 INSERT/SELECT trip_pois
--
-- 如果順序顛倒：舊 backend SQL fail "no such column" 或 "no such table"。
--
-- =============================================
-- 1. DROP indexes referencing dropped columns
-- =============================================
-- SQLite 不允許 DROP COLUMN 帶 referencing INDEX；migration 0026 建的 idx_trip_entries_poi_id
-- 必須先 DROP。
--
DROP INDEX IF EXISTS idx_trip_entries_poi_id;

-- =============================================
-- 2. DROP trip_entries 8 cols
-- =============================================
-- time / poi_id：v2.26.0 / v2.27.0 phase 1 已 dual-write，新 master 為 start_time/end_time
-- 跟 trip_entry_pois.sort_order=1。
--
-- travel_*：v2.24.0 trip_segments 上線後 deprecated。本 PR 完成 trip_segments cutover
-- (_merge.ts 改 bulk lookup segments)，此 6 cols 不再被讀寫。
--
ALTER TABLE trip_entries DROP COLUMN time;
ALTER TABLE trip_entries DROP COLUMN poi_id;
ALTER TABLE trip_entries DROP COLUMN travel_type;
ALTER TABLE trip_entries DROP COLUMN travel_desc;
ALTER TABLE trip_entries DROP COLUMN travel_min;
ALTER TABLE trip_entries DROP COLUMN travel_distance_m;
ALTER TABLE trip_entries DROP COLUMN travel_computed_at;
ALTER TABLE trip_entries DROP COLUMN travel_source;

-- =============================================
-- 3. DROP trip_destinations 2 cols
-- =============================================
-- osm_id / osm_type：v2.23.0 Google Maps 切換後 deprecated。POI canonical id 為
-- pois.place_id（Google ChIJ）。trip_destinations 本身已不用 osm fields。
--
ALTER TABLE trip_destinations DROP COLUMN osm_id;
ALTER TABLE trip_destinations DROP COLUMN osm_type;

-- =============================================
-- 4. DROP TABLE trip_pois
-- =============================================
-- 整表 die。Hotel 已在 trip_days.hotel_poi_id，entry-level shopping 已在
-- trip_entry_pois，day-level shopping (24 rows) 已 DELETE (0061)，timeline context
-- 早在 v2.28.0 migration 0059 已 DELETE。
--
DROP TABLE trip_pois;

-- =============================================
-- 5. ANALYZE
-- =============================================

ANALYZE trip_entries;
ANALYZE trip_destinations;
