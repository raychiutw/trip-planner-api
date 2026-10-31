-- Migration 0012: recreate restaurants 和 shopping 表，sort_order 加 NOT NULL DEFAULT 0
-- 安全性確認：
--   restaurants: 被 entries ON DELETE CASCADE 引用，但 restaurants 本身不被其他表 FK 引用 → 可 recreate
--   shopping: 使用 parent_type/parent_id（軟參照），不被任何表 FK 引用 → 可 recreate
-- 策略：CREATE new_table → INSERT from old → DROP old → RENAME new → recreate indexes

-- ============================================================
-- restaurants 表 recreate
-- ============================================================

CREATE TABLE IF NOT EXISTS restaurants_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  category        TEXT,
  hours           TEXT,
  price           TEXT,
  reservation     TEXT,
  reservation_url TEXT,
  description     TEXT,
  note            TEXT,
  rating          REAL,
  maps            TEXT,
  mapcode         TEXT,
  source          TEXT DEFAULT 'ai'
);

INSERT INTO restaurants_new (id, entry_id, sort_order, name, category, hours, price, reservation, reservation_url, description, note, rating, maps, mapcode, source)
SELECT id, entry_id, COALESCE(sort_order, 0), name, category, hours, price, reservation, reservation_url, description, note, rating, maps, mapcode, source
FROM restaurants;

DROP TABLE restaurants;
ALTER TABLE restaurants_new RENAME TO restaurants;

-- 確保 AUTOINCREMENT 序列延續原始值（避免 ID 重置衝突）
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
VALUES ('restaurants', (SELECT COALESCE(MAX(id), 0) FROM restaurants));

CREATE INDEX IF NOT EXISTS idx_restaurants_entry ON restaurants(entry_id);

-- ============================================================
-- shopping 表 recreate
-- ============================================================

CREATE TABLE IF NOT EXISTS shopping_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_type     TEXT NOT NULL CHECK (parent_type IN ('hotel', 'entry')),
  parent_id       INTEGER NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  category        TEXT,
  hours           TEXT,
  must_buy        TEXT,
  note            TEXT,
  rating          REAL,
  maps            TEXT,
  mapcode         TEXT,
  source          TEXT DEFAULT 'ai'
);

INSERT INTO shopping_new (id, parent_type, parent_id, sort_order, name, category, hours, must_buy, note, rating, maps, mapcode, source)
SELECT id, parent_type, parent_id, COALESCE(sort_order, 0), name, category, hours, must_buy, note, rating, maps, mapcode, source
FROM shopping;

DROP TABLE shopping;
ALTER TABLE shopping_new RENAME TO shopping;

-- 確保 AUTOINCREMENT 序列延續原始值（避免 ID 重置衝突）
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
VALUES ('shopping', (SELECT COALESCE(MAX(id), 0) FROM shopping));

CREATE INDEX IF NOT EXISTS idx_shopping_parent ON shopping(parent_type, parent_id);
