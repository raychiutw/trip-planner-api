-- Migration 0063: DROP TABLE saved_pois (poi-favorites-rename Phase 2)
--
-- Context: migration 0050 (v2.22.0, 2026-05-04) 用 expand-contract pattern
-- CREATE poi_favorites + INSERT SELECT FROM saved_pois。10 天 soak 過後
-- (2026-05-14)，grep 確認 functions/ 0 reads/writes saved_pois，prod 2 rows
-- (2026-04-26 + 2026-05-02，皆早於 v2.22.0 ship)，poi_favorites 4 rows
-- 涵蓋 2 個 migrated rows + 2 個 post-v2.22.0 new rows。
--
-- Phase 2 contract:
--   1. DROP INDEX idx_saved_pois_poi (SQLite require explicit DROP before TABLE)
--   2. DROP TABLE saved_pois
--
-- Rollback: migrations/rollback/0063_drop_saved_pois_rollback.sql 從 backups/
-- restore（saved_pois 已 expand-only 10 天，rollback 需 D1 Time Travel）。

DROP INDEX IF EXISTS idx_saved_pois_poi;
DROP TABLE IF EXISTS saved_pois;
