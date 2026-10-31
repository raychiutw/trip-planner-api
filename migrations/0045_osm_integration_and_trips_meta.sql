-- 0045: OSM Integration + Trip Modal v2 (2026-05-02)
--
-- Changes:
--   1. trips: DROP 6 dead/over-engineered cols (auto_scroll, og_description, footer,
--      food_prefs, is_default, self_drive). ADD 3 new (data_source, default_travel_mode, lang).
--      `region` not added — derived from trip_destinations join.
--   2. NEW trip_destinations table — normalize multi-dest (lat/lng/day_quota/sub_areas/osm_id).
--   3. pois: rename google_rating → rating (1-7 OpenTripMap scale, was 1-5 Google).
--      UPDATE rating=NULL to clear stale 1-5 values; batch enrich script
--      (scripts/poi-enrich-batch.ts) runs after migration to backfill from OpenTripMap.
--      DROP maps (replaced by mapsUrl helper). ADD 6 OSM追溯 cols.
--   4. trip_entries: ADD 3 travel cols (distance_m, computed_at, source) for
--      ORS/Haversine routing trace.

-- ===== trips: DROP 6 cols + ADD 3 cols =====
ALTER TABLE trips DROP COLUMN auto_scroll;
ALTER TABLE trips DROP COLUMN og_description;
ALTER TABLE trips DROP COLUMN footer;
ALTER TABLE trips DROP COLUMN food_prefs;
ALTER TABLE trips DROP COLUMN is_default;
ALTER TABLE trips DROP COLUMN self_drive;

ALTER TABLE trips ADD COLUMN data_source TEXT DEFAULT 'manual';
ALTER TABLE trips ADD COLUMN default_travel_mode TEXT DEFAULT 'driving';
ALTER TABLE trips ADD COLUMN lang TEXT DEFAULT 'zh-TW';

-- ===== trip_destinations: NEW table for multi-dest normalization =====
CREATE TABLE IF NOT EXISTS trip_destinations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  dest_order  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  lat         REAL,
  lng         REAL,
  day_quota   INTEGER,
  sub_areas   TEXT,                                    -- JSON array string, e.g. '["梅田","難波"]'
  osm_id      INTEGER,
  osm_type    TEXT,                                    -- 'node' | 'way' | 'relation'
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trip_destinations_trip ON trip_destinations(trip_id, dest_order);

-- ===== pois: rename + clear rating + DROP maps + ADD 6 OSM cols =====
ALTER TABLE pois RENAME COLUMN google_rating TO rating;
UPDATE pois SET rating = NULL WHERE rating IS NOT NULL;
ALTER TABLE pois DROP COLUMN maps;

ALTER TABLE pois ADD COLUMN osm_id          INTEGER;
ALTER TABLE pois ADD COLUMN osm_type        TEXT;        -- 'node' | 'way' | 'relation'
ALTER TABLE pois ADD COLUMN wikidata_id     TEXT;        -- Q12345
ALTER TABLE pois ADD COLUMN cuisine         TEXT;        -- OSM cuisine tag (japanese/ramen/...)
ALTER TABLE pois ADD COLUMN data_source     TEXT;        -- 'opentripmap'|'osm'|'manual'|'merged'
ALTER TABLE pois ADD COLUMN data_fetched_at INTEGER;     -- unix ms; enrich respects 90d cache
CREATE INDEX IF NOT EXISTS idx_pois_osm ON pois(osm_id, osm_type);

-- ===== trip_entries: ADD travel完整 cols =====
ALTER TABLE trip_entries ADD COLUMN travel_distance_m   INTEGER;
ALTER TABLE trip_entries ADD COLUMN travel_computed_at  INTEGER;     -- unix ms
ALTER TABLE trip_entries ADD COLUMN travel_source       TEXT;        -- 'ors'|'osrm'|'haversine'|'manual'
