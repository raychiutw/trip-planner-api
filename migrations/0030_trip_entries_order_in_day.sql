-- Migration 0030: trip_entries.order_in_day — drag reorder 的穩定 sort key
--
-- Phase 1 底層 schema（layout-overlay-rules-and-schema change）。為 Phase 5
-- ideas-drag-to-itinerary 的 within-Day / cross-Day drag reorder 提供穩定
-- 排序欄位（既有靠 start_time 排序，在同時段多 entry 時 tie 不穩定）。
--
-- DEFAULT 0：所有既有 entry 填 0（非 NOT NULL backfill 風險最低）。
-- Phase 5 實作 drag 時會一次性 backfill 連號（ROW_NUMBER() OVER PARTITION
-- BY day_id ORDER BY start_time），讓 within-Day 排序穩定。
--
-- Composite index (day_id, order_in_day)：支援「列某天的 entries 排序」
-- 的主要 query pattern（Phase 5 drag 寫入 + Itinerary tab 讀取）。

ALTER TABLE trip_entries ADD COLUMN order_in_day INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_trip_entries_order ON trip_entries(day_id, order_in_day);
