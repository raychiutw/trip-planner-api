-- 行程主表
CREATE TABLE IF NOT EXISTS trips (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner           TEXT NOT NULL,
  title           TEXT,
  description     TEXT,
  og_description  TEXT,
  self_drive      INTEGER DEFAULT 0,
  countries       TEXT DEFAULT 'JP',
  published       INTEGER DEFAULT 1,
  food_prefs      TEXT,
  auto_scroll     TEXT,
  footer_json     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 天
CREATE TABLE IF NOT EXISTS days (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_num         INTEGER NOT NULL,
  date            TEXT,
  day_of_week     TEXT,
  label           TEXT,
  weather_json    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trip_id, day_num)
);
CREATE INDEX IF NOT EXISTS idx_days_trip ON days(trip_id);

-- 飯店（每天 0~1）
CREATE TABLE IF NOT EXISTS hotels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id          INTEGER NOT NULL UNIQUE REFERENCES days(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  checkout        TEXT,
  source          TEXT DEFAULT 'ai',
  details         TEXT,
  breakfast       TEXT,
  note            TEXT,
  parking_json    TEXT
);

-- 時間軸項目
CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id          INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL,
  time            TEXT,
  title           TEXT NOT NULL,
  body            TEXT,
  source          TEXT DEFAULT 'ai',
  maps            TEXT,
  mapcode         TEXT,
  rating          REAL,
  note            TEXT,
  travel_type     TEXT,
  travel_desc     TEXT,
  travel_min      INTEGER,
  location_json   TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day_id);

-- 餐廳推薦
CREATE TABLE IF NOT EXISTS restaurants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  sort_order      INTEGER DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_restaurants_entry ON restaurants(entry_id);

-- 購物推薦
CREATE TABLE IF NOT EXISTS shopping (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_type     TEXT NOT NULL CHECK (parent_type IN ('hotel', 'entry')),
  parent_id       INTEGER NOT NULL,
  sort_order      INTEGER DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_shopping_parent ON shopping(parent_type, parent_id);

-- 附屬文件
CREATE TABLE IF NOT EXISTS trip_docs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('flights','checklist','backup','suggestions','emergency')),
  content         TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trip_id, doc_type)
);
CREATE INDEX IF NOT EXISTS idx_docs_trip ON trip_docs(trip_id);

-- 審計記錄
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL,
  table_name      TEXT NOT NULL,
  record_id       INTEGER,
  action          TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  changed_by      TEXT,
  request_id      INTEGER,
  diff_json       TEXT,
  snapshot        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_trip ON audit_log(trip_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
