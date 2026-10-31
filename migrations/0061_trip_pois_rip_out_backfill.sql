-- Migration 0061: trip_pois rip-out phase 2 — Backfill + DELETE day-level shopping
--
-- ## Background
--
-- 接續 migration 0060。此 migration 在 backend cutover 完成後 apply。
--
-- ## Scope
--
-- 1. Backfill hotel：trip_pois(context='hotel') → trip_days.hotel_poi_id（INNER JOIN safety，多筆同 day 取最新 updated_at）
-- 2. Backfill entry-level shopping：trip_pois(context='shopping', entry_id IS NOT NULL)
--    → trip_entry_pois（接續既有 sort_order，含 description/note/reservation/reservation_url）
-- 3. DELETE day-level shopping (24 rows in production, entry_id IS NULL)
--
-- Day-level shopping 是 user-decided data loss：production 24 rows 是「當天可順路採買」
-- 參考資料，無時間語意，遷移成本高過保留價值（user 同意丟）。
--
-- ## Deploy 順序（hard rule）
--
-- Apply order：0060 → backend deploy → wait 60s → 0061 (此檔) → 0062
--
-- 必須在 backend 完成 cutover (不再 INSERT trip_pois) 後 apply，否則 backfill
-- 過後新進來的 hotel 還會掉進 trip_pois，導致 0062 DROP TABLE 時 silent data loss。
--
-- =============================================
-- 1. Backfill hotel → trip_days.hotel_poi_id
-- =============================================
-- 規則：同 day 多筆 hotel 取最新 updated_at（理論上應該每 day 只有 1 row）。
-- INNER JOIN safety：trip_pois.day_id / poi_id 對應不到 trip_days / pois 的 row 不遷（孤兒丟棄）。
-- SET 子查詢必須一致 INNER JOIN pois，避免「latest tp.updated_at 的 row 指向已刪 POI」
-- 寫成 dangling FK 觸發 hotel_poi_id REFERENCES pois 的 NOT NULL 檢查或 silent bad write。
--
UPDATE trip_days
SET hotel_poi_id = (
  SELECT tp.poi_id
  FROM trip_pois tp
  INNER JOIN pois p ON tp.poi_id = p.id
  WHERE tp.day_id = trip_days.id
    AND tp.context = 'hotel'
    AND tp.poi_id IS NOT NULL
  ORDER BY tp.updated_at DESC
  LIMIT 1
)
WHERE id IN (
  SELECT DISTINCT tp.day_id
  FROM trip_pois tp
  INNER JOIN trip_days td ON tp.day_id = td.id
  INNER JOIN pois p ON tp.poi_id = p.id
  WHERE tp.context = 'hotel'
);

-- =============================================
-- 2. Backfill entry-level shopping → trip_entry_pois
-- =============================================
-- 規則：sort_order = entry 既有 max sort_order + ROW_NUMBER (避免 UNIQUE 衝突)。
-- INNER JOIN safety：trip_pois.entry_id / poi_id 對應不到 trip_entries / pois 的丟棄。
-- 用 _m0061_shopping_backfill temp table 計算 sort_order 一次性。
--
DROP TABLE IF EXISTS _m0061_shopping_backfill;

-- trip_pois 沒 UNIQUE(entry_id, poi_id)，legacy 可能存在 duplicate (entry, poi)。
-- 目標 trip_entry_pois 有 UNIQUE(entry_id, poi_id)，重複 INSERT 觸發 CONSTRAINT_UNIQUE。
-- _m0061_dedup CTE 同 (entry, poi) 留最早 row（lowest sort_order, lowest id），
-- 再 LEFT JOIN 排除已存在 trip_entry_pois 的 pair。
CREATE TABLE _m0061_shopping_backfill AS
WITH _m0061_dedup AS (
  SELECT
    tp.entry_id,
    tp.poi_id,
    tp.description,
    tp.note,
    tp.reservation,
    tp.reservation_url,
    tp.created_at AS added_at,
    tp.updated_at,
    ROW_NUMBER() OVER (PARTITION BY tp.entry_id, tp.poi_id ORDER BY tp.sort_order, tp.id) AS dedup_rn
  FROM trip_pois tp
  INNER JOIN trip_entries te ON tp.entry_id = te.id
  INNER JOIN pois p ON tp.poi_id = p.id
  WHERE tp.context = 'shopping'
    AND tp.entry_id IS NOT NULL
)
SELECT
  d.entry_id,
  d.poi_id,
  (COALESCE((SELECT MAX(sort_order) FROM trip_entry_pois WHERE entry_id = d.entry_id), 0)
    + ROW_NUMBER() OVER (PARTITION BY d.entry_id ORDER BY d.added_at, d.poi_id)) AS sort_order,
  d.description,
  d.note,
  d.reservation,
  d.reservation_url,
  d.added_at,
  d.updated_at
FROM _m0061_dedup d
WHERE d.dedup_rn = 1
  -- 防範 UNIQUE(entry_id, poi_id)：如果該 (entry, poi) 已在 trip_entry_pois，不重複 INSERT
  AND NOT EXISTS (
    SELECT 1 FROM trip_entry_pois tep
    WHERE tep.entry_id = d.entry_id AND tep.poi_id = d.poi_id
  );

INSERT INTO trip_entry_pois (
  entry_id, poi_id, sort_order,
  description, note, reservation, reservation_url,
  added_at, updated_at
)
SELECT
  entry_id, poi_id, sort_order,
  description, note, reservation, reservation_url,
  added_at, updated_at
FROM _m0061_shopping_backfill
ORDER BY entry_id, sort_order;

DROP TABLE _m0061_shopping_backfill;

-- 觸發 entry_pois_version OCC bump（讀者看見 backfill 後的新 list）
UPDATE trip_entries
SET entry_pois_version = entry_pois_version + 1
WHERE id IN (
  SELECT DISTINCT entry_id
  FROM trip_entry_pois
  WHERE entry_id IN (
    SELECT DISTINCT entry_id
    FROM trip_pois
    WHERE context = 'shopping' AND entry_id IS NOT NULL
  )
);

-- =============================================
-- 3. DELETE day-level shopping (data loss accepted)
-- =============================================
-- Production 24 rows (entry_id IS NULL)。User 決定丟。
--
DELETE FROM trip_pois
WHERE context = 'shopping' AND entry_id IS NULL;

-- =============================================
-- 4. ANALYZE
-- =============================================

ANALYZE trip_days;
ANALYZE trip_entry_pois;
ANALYZE trip_entries;
ANALYZE trip_pois;
