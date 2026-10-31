-- 0052_trips_self_drive.sql — v2.23.8 self-drive support
--
-- Adds 5 nullable columns to trips for self-drive (rental car) trip planning:
--   self_drive_enabled         BOOLEAN (0/1) — master toggle
--   self_drive_pickup_at       TEXT (ISO datetime YYYY-MM-DDTHH:MM)
--   self_drive_return_at       TEXT (ISO datetime YYYY-MM-DDTHH:MM)
--   self_drive_pickup_location TEXT (free-form, e.g. "那霸機場 OTS 取車櫃台")
--   self_drive_return_location TEXT (free-form)
--
-- 全部 nullable 支援「後補」流程 — user 可建 trip 時不填，後續 EditTripPage 補。
--
-- recompute-travel 改用 per-pair mode logic：
--   pair 兩端都在 [pickup_at, return_at] 區間 → DRIVE
--   區間外：先試 WALK，duration ≤10min → WALK / 否則 TRANSIT
--
-- v2.19.x 曾 DROP 過 trips.self_drive (boolean only)；本次回填為結構化資料。

ALTER TABLE trips ADD COLUMN self_drive_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN self_drive_pickup_at TEXT;
ALTER TABLE trips ADD COLUMN self_drive_return_at TEXT;
ALTER TABLE trips ADD COLUMN self_drive_pickup_location TEXT;
ALTER TABLE trips ADD COLUMN self_drive_return_location TEXT;

-- partial index for trips with self-drive enabled (rare query path; index small)
CREATE INDEX IF NOT EXISTS idx_trips_self_drive_enabled
  ON trips(id) WHERE self_drive_enabled = 1;
