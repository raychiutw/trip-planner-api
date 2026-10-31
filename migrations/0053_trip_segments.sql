-- 0053_trip_segments.sql — v2.24.0 拉出兩 entry 之間的「交通段」為 first-class entity
--
-- v2.x 起 trip_entries.travel_* 黏在 entry 上的 flat fields（travel_type / travel_desc
-- / travel_min / travel_distance_m / travel_computed_at / travel_source）會在 v2.24.0
-- 後續 migration 0055 廢除（DROP COLUMN）。本 migration 只 CREATE 新表。
--
-- 1km gate 邏輯（recompute-travel 寫入時）：
--   haversine(prev, next) ≤ 1000m → mode='walking'  (1 Routes API call)
--   haversine(prev, next) > 1000m → mode='driving'  (1 Routes API call)
--   self-drive 窗內亦吃 1km gate（短程仍 walking — 找停車位比走路慢）
--
-- mode_source：
--   'auto' — recompute-travel 算的（會被 recompute 覆寫）
--   'user' — user 手動切換（recompute 不覆寫，保留 user override）
--
-- transit mode 不打 Google API（Japan 沒 transit 資料）。user 手動切到 transit 時
-- 需自填 min（PATCH /api/trips/:id/segments/:sid 帶 mode='transit' + min=N）。

CREATE TABLE IF NOT EXISTS trip_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  from_entry_id INTEGER NOT NULL,
  to_entry_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'driving'
    CHECK (mode IN ('driving', 'walking', 'transit')),
  mode_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (mode_source IN ('auto', 'user')),
  min INTEGER,
  distance_m INTEGER,
  source TEXT
    CHECK (source IS NULL OR source IN ('google', 'manual', 'haversine', 'error')),
  computed_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (from_entry_id) REFERENCES trip_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entry_id) REFERENCES trip_entries(id) ON DELETE CASCADE,
  UNIQUE (from_entry_id, to_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_segments_trip ON trip_segments(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_segments_from ON trip_segments(from_entry_id);
CREATE INDEX IF NOT EXISTS idx_trip_segments_to ON trip_segments(to_entry_id);
