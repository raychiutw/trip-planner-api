-- v2.31.36: DROP 6 dead trips columns
--
-- `default_travel_mode` + 5 self_drive_* columns 在 UI（EditTripPage / NewTripPage）
-- 收集 user 輸入後存進 trips 表，但 backend 沒任何 logic 讀取此 column 影響行為：
--   - segment mode 由 recompute-travel.ts:146 `distHaversine <= WALK_GATE_M` 決定（純 Haversine）
--   - 加 stop / day default 沒讀此 column
--   - AI 健檢 sanitize 沒讀
--   - tp-create / route compute / search 都沒讀
-- 推測原 design intent 是給 v2.23.0 切 Google Maps Platform 之前的 ORS 路徑計算用，
-- ORS rip out 後 column 沒同步 cleanup → schema-only persisted preference。
--
-- DROP COLUMN：
--   default_travel_mode TEXT
--   self_drive_enabled INTEGER (0/1)
--   self_drive_pickup_at TEXT (ISO)
--   self_drive_return_at TEXT (ISO)
--   self_drive_pickup_location TEXT
--   self_drive_return_location TEXT
--
-- Deploy 順序（按 user 選「單 PR」path）：
--   1. backend code 不再 read/write 此 6 columns（ALLOWED_FIELDS / INSERT VALUES /
--      validation / audit rollback list 同 PR cleanup）
--   2. merge PR + CF Pages auto-deploy
--   3. apply migration（DROP COLUMN）
-- Race window：columns 都 nullable + 無 FK + 無 NOT NULL constraint 下游，理論上 deploy
-- 與 migration 之間 race 不會炸（backend 不寫 = SQL 不引用 = 不會因 missing column fail）。
--
-- Rollback: rollback/0068_drop_dead_trip_fields_rollback.sql adds back 6 nullable columns
-- (data loss — original values not preserved). 但因 dead data，rollback 等於空白 columns，
-- 沒實際救援價值；單純為 schema parity 保留 rollback file。

-- Drop index that references self_drive_enabled column first（SQLite 不允許
-- DROP COLUMN 當 index 仍 reference）。Migration 0052 創立此 index。
DROP INDEX IF EXISTS idx_trips_self_drive_enabled;

ALTER TABLE trips DROP COLUMN default_travel_mode;
ALTER TABLE trips DROP COLUMN self_drive_enabled;
ALTER TABLE trips DROP COLUMN self_drive_pickup_at;
ALTER TABLE trips DROP COLUMN self_drive_return_at;
ALTER TABLE trips DROP COLUMN self_drive_pickup_location;
ALTER TABLE trips DROP COLUMN self_drive_return_location;
