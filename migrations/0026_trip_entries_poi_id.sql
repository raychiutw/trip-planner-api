-- Migration 0026: trip_entries.poi_id FK（nullable during migration）
--
-- 目標：trip_entries 加 poi_id 欄位，建立 entry → pois master 的 FK。
-- Phase 1 後 nullable；Phase 2 資料遷移 backfill 後仍 nullable（避免 breaking
-- 任何 legacy insert path）；Phase 3 可改 NOT NULL（若決定強制）。
--
-- 寫入路徑（Phase 2 之後）：
--   - PUT /days/:num / POST /entries 走 batchFindOrCreatePois 後回填 poi_id
--   - PATCH /entries/:eid 可改 poi_id（換 POI master）
--
-- 讀取路徑：
--   - GET /days/:num JOIN pois ON trip_entries.poi_id = pois.id 取 spatial 欄位
--   - toTimelineEntry 優先讀 POI；entry.location override 作為 Phase 2 遷移期 fallback
--
-- index：poi_id 會被 GET 路徑頻繁 JOIN，建 index 提速。

ALTER TABLE trip_entries ADD COLUMN poi_id INTEGER REFERENCES pois(id);

CREATE INDEX idx_trip_entries_poi_id ON trip_entries(poi_id);
