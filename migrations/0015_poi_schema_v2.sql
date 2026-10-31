-- POI Schema V2 — 正規化 + 零 JSON + 扁平化類型欄位
--
-- ⚠️ 安全說明：
-- pois/trip_pois 在 migration 0014 建立但零資料（migrate-pois.js 未執行）
-- DROP 安全：不影響任何現有資料
-- 先 DROP trip_pois（有 FK 指向 pois），再 DROP pois

-- =============================================
-- 1. DROP 空表（0014 建的舊 schema）
-- =============================================

DROP TABLE IF EXISTS trip_pois;
DROP TABLE IF EXISTS pois;

-- =============================================
-- 2. 重建 pois（零 JSON — lat/lng 獨立欄位）
-- =============================================

CREATE TABLE pois (
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
  lat           REAL,
  lng           REAL,
  country       TEXT DEFAULT 'JP',
  source        TEXT DEFAULT 'ai',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pois_type ON pois(type);
CREATE INDEX idx_pois_name ON pois(name);

-- =============================================
-- 3. 重建 trip_pois（扁平化類型欄位，無 parent FK）
-- =============================================

CREATE TABLE trip_pois (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id             TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  poi_id              INTEGER NOT NULL REFERENCES pois(id),
  context             TEXT NOT NULL CHECK (context IN ('hotel','timeline','shopping')),
  day_id              INTEGER REFERENCES trip_days(id) ON DELETE CASCADE,
  entry_id            INTEGER REFERENCES trip_entries(id) ON DELETE CASCADE,
  sort_order          INTEGER DEFAULT 0,
  -- 覆寫欄位（NULL = 繼承 master）
  description         TEXT,
  note                TEXT,
  hours               TEXT,
  -- 類型專屬欄位（扁平化 nullable）
  checkout            TEXT,
  breakfast_included  INTEGER,
  breakfast_note      TEXT,
  price               TEXT,
  reservation         TEXT,
  reservation_url     TEXT,
  must_buy            TEXT,
  -- meta
  source              TEXT DEFAULT 'ai',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (
    (context = 'hotel' AND day_id IS NOT NULL) OR
    (context IN ('timeline','shopping') AND (entry_id IS NOT NULL OR day_id IS NOT NULL))
  )
);

CREATE INDEX idx_trip_pois_trip ON trip_pois(trip_id);
CREATE INDEX idx_trip_pois_poi ON trip_pois(poi_id);
CREATE INDEX idx_trip_pois_day ON trip_pois(day_id);
CREATE INDEX idx_trip_pois_entry ON trip_pois(entry_id);

-- =============================================
-- 4. POI 關聯表（停車場↔飯店 多對多）
-- =============================================

CREATE TABLE poi_relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_id          INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  related_poi_id  INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('parking','nearby')),
  note            TEXT,
  UNIQUE(poi_id, related_poi_id, relation_type)
);
