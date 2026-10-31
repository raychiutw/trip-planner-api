-- Migration 0028: saved_pois — 使用者跨 trip 的 POI 收藏池
--
-- Phase 1 底層 schema（layout-overlay-rules-and-schema change）。為 Phase 4
-- Explore nav 的儲存池 + 加到 trip 流程提供資料基礎。
--
-- owner 欄位：暫以 email TEXT（對齊 trip_permissions.email / audit_log.changed_by）。
-- V2 OAuth plan ship 後，另做 migration backfill user_id FK（類 trip_permissions
-- 的 backfill 策略，不破壞現有 row）。
--
-- FK：poi_id → pois(id) ON DELETE CASCADE — POI 被刪時相關收藏自動清，避免 orphan。
-- 無 user FK（email 非 FK，因 users table 尚未建立）。
--
-- UNIQUE (email, poi_id)：同一使用者不可重複收藏同一 POI；應用層抓 `UNIQUE`
-- constraint violation 轉 DATA_CONFLICT (HTTP 409)。

CREATE TABLE saved_pois (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  email     TEXT NOT NULL,
  poi_id    INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  saved_at  TEXT NOT NULL DEFAULT (datetime('now')),
  note      TEXT,
  UNIQUE (email, poi_id)
);

CREATE INDEX idx_saved_pois_email ON saved_pois(email);
CREATE INDEX idx_saved_pois_poi ON saved_pois(poi_id);
