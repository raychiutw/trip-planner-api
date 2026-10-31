-- Migration 0029: trip_ideas — per-trip 的 maybe list
--
-- Phase 1 底層 schema（layout-overlay-rules-and-schema change）。為 Phase 3
-- TripSheet Ideas tab 與 Phase 5 drag-to-promote 提供資料基礎。
--
-- FK 語意（刻意不同）：
--   trip_id              → trips(id) ON DELETE CASCADE        — trip 被刪 ideas 自動清
--   poi_id               → pois(id) ON DELETE SET NULL        — POI 被刪保留 idea 文字
--   promoted_to_entry_id → trip_entries(id) ON DELETE SET NULL — entry 被刪 idea 仍在，
--                                                                失去 promote 標記，可再 promote
--
-- archived_at：soft delete（UI 預設 filter `archived_at IS NULL`），保留原 row
-- 供 audit / undo。added_by 是 email string（對齊 audit_log.changed_by），
-- V2 OAuth 時另做 backfill。

CREATE TABLE trip_ideas (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id               TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  poi_id                INTEGER REFERENCES pois(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  note                  TEXT,
  added_at              TEXT NOT NULL DEFAULT (datetime('now')),
  added_by              TEXT,
  promoted_to_entry_id  INTEGER REFERENCES trip_entries(id) ON DELETE SET NULL,
  archived_at           TEXT
);

CREATE INDEX idx_trip_ideas_trip ON trip_ideas(trip_id);
CREATE INDEX idx_trip_ideas_poi ON trip_ideas(poi_id);
CREATE INDEX idx_trip_ideas_archived ON trip_ideas(archived_at);
