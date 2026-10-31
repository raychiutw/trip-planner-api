-- Migration 0074: trip_lodgings.day_id (INTEGER FK) → junction table trip_lodging_days
-- v2.34.44 PR44: User feedback — 住宿可跨多天，且「不連續天的相同飯店視為不同紀錄」
-- 之前 single day_id 無法表達一筆 lodging 涵蓋多 day（例：7/2-7/4 共 3 晚同飯店 = 1 row 連結 Day 2/3/4）。
--
-- 正規化設計（user 指示 no JSON）：
--   trip_lodgings 拔 day_id column
--   新 trip_lodging_days junction table (lodging_id, day_id) PK 複合
--   ON DELETE CASCADE 雙向：lodging 刪 → junction cascade；day 刪 → junction cascade
--   Backfill: existing trip_lodgings.day_id NOT NULL → INSERT 1 row 到 junction
--
-- 不變更 idx_trip_lodgings_*。Frontend 業務邏輯保證 day_id 屬於同 trip。

-- Atomicity 走 D1 runner（miniflare 不支援 BEGIN/COMMIT — 用 statement-by-statement）

-- Step 1: 建立 junction table
CREATE TABLE IF NOT EXISTS trip_lodging_days (
  lodging_id INTEGER NOT NULL REFERENCES trip_lodgings(id) ON DELETE CASCADE,
  day_id INTEGER NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
  PRIMARY KEY (lodging_id, day_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_lodging_days_day_id ON trip_lodging_days(day_id);

-- Step 2: Backfill 既有 trip_lodgings.day_id NOT NULL row 到 junction
INSERT INTO trip_lodging_days (lodging_id, day_id)
SELECT id, day_id FROM trip_lodgings WHERE day_id IS NOT NULL;

-- Step 3: 拔 trip_lodgings.day_id column（SQLite 用 NEW TABLE pattern）
CREATE TABLE trip_lodgings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  address TEXT,
  check_in_at TEXT,
  check_out_at TEXT,
  booking_no TEXT,
  phone TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO trip_lodgings_new (
  id, trip_id, sort_order, version, name, address,
  check_in_at, check_out_at, booking_no, phone, note,
  created_at, updated_at
)
SELECT
  id, trip_id, sort_order, version, name, address,
  check_in_at, check_out_at, booking_no, phone, note,
  created_at, updated_at
FROM trip_lodgings;

DROP TABLE trip_lodgings;
ALTER TABLE trip_lodgings_new RENAME TO trip_lodgings;

CREATE INDEX IF NOT EXISTS idx_trip_lodgings_trip_id ON trip_lodgings(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_lodgings_trip_sort ON trip_lodgings(trip_id, sort_order);
