-- Migration 0025: Extend POI types — add 'activity'
--
-- 目標：pois.type CHECK 納入 'activity'，讓體驗活動（浮潛 / 玉泉洞 / 名護鳳梨園）
-- 可作為 POI master，與 attraction / transport 區隔清楚。
--
-- SQLite 限制：ALTER TABLE 不支援 modify CHECK，必須 table rebuild。
-- D1 限制：
--   1. foreign_keys=ON 強制在 COMMIT 時檢查
--   2. PRAGMA foreign_keys 在 transaction 內無效
--   3. CREATE TEMP TABLE 被 SQLITE_AUTH 拒絕
--
-- 解法（triple-rename swap）：
--   pois 有 2 個 dependent tables：trip_pois、poi_relations。SQLite `ALTER TABLE
--   pois RENAME TO pois_old` 會同步把所有 dependent 的 FK 重寫為指向 `pois_old`。
--   若只 rebuild trip_pois，poi_relations 會留下 `REFERENCES "pois_old"(id)` 的
--   殘骸，DROP pois_old 後 poi_relations 任何 INSERT 會 `no such table` fail。
--   解法：把 poi_relations 也納入 rebuild。
--
-- 步驟：
--   1. pois → pois_old（兩個 dependent FK 自動改指 pois_old）
--   2. 建新 pois（新 CHECK）+ copy data
--   3. trip_pois → trip_pois_old（FK 仍指 pois_old）
--   4. 建新 trip_pois（FK 指 pois）+ copy data
--   5. poi_relations → poi_relations_old（FK 仍指 pois_old）
--   6. 建新 poi_relations（FK 指 pois）+ copy data
--   7. DROP poi_relations_old → DROP trip_pois_old → DROP pois_old
--   8. 重建全部 indexes
--
-- 新 allowed types（依序）：
--   hotel / restaurant / shopping / parking / attraction / transport / activity / other

-- ============================================================
-- 1. 把 pois 改名避讓（trip_pois.FK 會 auto-follow 指 pois_old）
-- ============================================================
ALTER TABLE pois RENAME TO pois_old;

-- ============================================================
-- 2. 建新 pois（新 CHECK 加 'activity'）+ copy data（id 保持）
-- ============================================================
CREATE TABLE pois (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL CHECK (type IN ('hotel','restaurant','shopping','parking','attraction','transport','activity','other')),
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

INSERT INTO pois SELECT * FROM pois_old;

-- ============================================================
-- 3. 把 trip_pois → trip_pois_old（其 FK 仍指 pois_old，讓新 trip_pois 指新 pois）
-- ============================================================
ALTER TABLE trip_pois RENAME TO trip_pois_old;

-- ============================================================
-- 4. 建新 trip_pois（FK 指 pois；schema 同 0015 + 0016）+ copy data
-- ============================================================
CREATE TABLE trip_pois (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id             TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  poi_id              INTEGER NOT NULL REFERENCES pois(id),
  context             TEXT NOT NULL CHECK (context IN ('hotel','timeline','shopping')),
  day_id              INTEGER REFERENCES trip_days(id) ON DELETE CASCADE,
  entry_id            INTEGER REFERENCES trip_entries(id) ON DELETE CASCADE,
  sort_order          INTEGER DEFAULT 0,
  description         TEXT,
  note                TEXT,
  hours               TEXT,
  checkout            TEXT,
  breakfast_included  INTEGER,
  breakfast_note      TEXT,
  price               TEXT,
  reservation         TEXT,
  reservation_url     TEXT,
  must_buy            TEXT,
  source              TEXT DEFAULT 'ai',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (context = 'hotel' AND day_id IS NOT NULL) OR
    (context IN ('timeline','shopping') AND (entry_id IS NOT NULL OR day_id IS NOT NULL))
  )
);

INSERT INTO trip_pois SELECT * FROM trip_pois_old;

-- ============================================================
-- 5. 把 poi_relations → poi_relations_old（FK 仍指 pois_old）
-- ============================================================
ALTER TABLE poi_relations RENAME TO poi_relations_old;

-- ============================================================
-- 6. 建新 poi_relations（FK 指 pois；schema 同 0015 / 0016）+ copy data
-- ============================================================
CREATE TABLE poi_relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_id          INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  related_poi_id  INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('parking','nearby')),
  note            TEXT,
  UNIQUE(poi_id, related_poi_id, relation_type)
);

INSERT INTO poi_relations SELECT * FROM poi_relations_old;

-- ============================================================
-- 7. 清除舊表（順序：最深 dependent 先 drop）
-- ============================================================
DROP TABLE poi_relations_old;
DROP TABLE trip_pois_old;
DROP TABLE pois_old;

-- ============================================================
-- 8. 重建 indexes（三個表）
-- ============================================================
CREATE INDEX idx_pois_type ON pois(type);
CREATE INDEX idx_pois_name ON pois(name);
CREATE INDEX idx_pois_country ON pois(country);
CREATE UNIQUE INDEX idx_pois_name_type ON pois(name, type);

CREATE INDEX idx_trip_pois_trip ON trip_pois(trip_id);
CREATE INDEX idx_trip_pois_poi ON trip_pois(poi_id);
CREATE INDEX idx_trip_pois_day ON trip_pois(day_id);
CREATE INDEX idx_trip_pois_entry ON trip_pois(entry_id);
