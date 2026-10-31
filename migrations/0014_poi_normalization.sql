-- POI 正規化 + 欄位統一 + 移除 _json 後綴 + 表名統一
-- 所有 DB 欄位名 = 前端欄位名（經 snakeToCamel 自動轉換）
-- 行程相關表統一加 trip_ 前綴

-- =============================================
-- 1. 表名統一：行程相關表加 trip_ 前綴
-- =============================================

ALTER TABLE days RENAME TO trip_days;
ALTER TABLE entries RENAME TO trip_entries;
ALTER TABLE requests RENAME TO trip_requests;
ALTER TABLE permissions RENAME TO trip_permissions;

-- =============================================
-- 2. 新表：pois master + trip_pois fork
-- =============================================

CREATE TABLE IF NOT EXISTS pois (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL CHECK (type IN ('hotel','restaurant','shopping','parking','attraction','transport','other')),
  name          TEXT NOT NULL,
  description   TEXT,
  note          TEXT,
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  website       TEXT,
  hours         TEXT,
  google_rating REAL,
  category      TEXT,
  maps          TEXT,
  mapcode       TEXT,
  location      TEXT,
  attrs         TEXT,
  country       TEXT DEFAULT 'JP',
  source        TEXT DEFAULT 'ai',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pois_type ON pois(type);
CREATE INDEX IF NOT EXISTS idx_pois_name ON pois(name);
CREATE INDEX IF NOT EXISTS idx_pois_country ON pois(country);

CREATE TABLE IF NOT EXISTS trip_pois (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  poi_id        INTEGER NOT NULL REFERENCES pois(id),
  context       TEXT NOT NULL CHECK (context IN ('hotel','timeline','shopping')),
  day_id        INTEGER REFERENCES trip_days(id) ON DELETE CASCADE,
  entry_id      INTEGER REFERENCES trip_entries(id) ON DELETE CASCADE,
  sort_order    INTEGER DEFAULT 0,
  description   TEXT,
  note          TEXT,
  hours         TEXT,
  trip_attrs    TEXT,
  source        TEXT DEFAULT 'ai',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (context = 'hotel' AND day_id IS NOT NULL) OR
    (context IN ('timeline','shopping') AND (entry_id IS NOT NULL OR day_id IS NOT NULL))
  )
);

CREATE INDEX IF NOT EXISTS idx_trip_pois_trip ON trip_pois(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_pois_poi ON trip_pois(poi_id);
CREATE INDEX IF NOT EXISTS idx_trip_pois_day ON trip_pois(day_id);
CREATE INDEX IF NOT EXISTS idx_trip_pois_entry ON trip_pois(entry_id);

-- =============================================
-- 3. trip_entries 欄位統一
-- =============================================

ALTER TABLE trip_entries RENAME COLUMN body TO description;
ALTER TABLE trip_entries RENAME COLUMN rating TO google_rating;
ALTER TABLE trip_entries RENAME COLUMN location_json TO location;

-- =============================================
-- 4. 移除 _json 後綴（所有現有表）
-- =============================================

ALTER TABLE trip_days DROP COLUMN weather_json;
ALTER TABLE hotels RENAME COLUMN details TO description;
ALTER TABLE hotels RENAME COLUMN parking_json TO parking;
ALTER TABLE trips RENAME COLUMN footer_json TO footer;
