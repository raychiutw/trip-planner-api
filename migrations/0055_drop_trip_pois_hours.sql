-- Migration 0055: drop trip_pois.hours — hours 純 pois master
--
-- ## Background
--
-- pois.hours 自始就在（migration 0014 schema_v2）。trip_pois.hours 原本是 user
-- override 機制，但 hours 是 POI 客觀屬性（每天營業時段不會因 trip 而異），
-- override 設計毫無意義。Place Details API 的 weekday_descriptions 已經把
-- 全週時段 + 公休日（「星期三: 休息」）都寫進 pois.hours，trip_pois.hours
-- 完全冗餘。
--
-- ## Scope
--
-- 1. Backfill：trip_pois.hours non-null → pois.hours（COALESCE 不覆蓋既有 pois.hours）
-- 2. DROP COLUMN trip_pois.hours
--
-- ## Deploy 順序（hard rule）
--
-- DROP COLUMN 必須在 backend stop writing 後才能 apply：
--   1. Merge PR（backend 不再 INSERT/UPDATE trip_pois.hours）
--   2. CF Pages auto-deploy backend
--   3. 手動 apply migration（此檔）
--
-- 如果順序顛倒：既有 prod backend 會 INSERT INTO trip_pois (..., hours, ...)
-- → SQL fail "no such column: hours"。
--
-- =============================================
-- 1. Backfill trip_pois.hours → pois.hours
-- =============================================
-- 規則：只 backfill pois.hours 為 NULL 的（保留 Place Details 寫入的全週時段）。
-- 同 poi 多筆 trip_pois.hours 衝突取最新 updated_at。
--
UPDATE pois
SET hours = (
  SELECT tp.hours
  FROM trip_pois tp
  WHERE tp.poi_id = pois.id
    AND tp.hours IS NOT NULL
    AND tp.hours != ''
  ORDER BY tp.updated_at DESC
  LIMIT 1
)
WHERE pois.hours IS NULL
  AND EXISTS (
    SELECT 1 FROM trip_pois tp
    WHERE tp.poi_id = pois.id
      AND tp.hours IS NOT NULL
      AND tp.hours != ''
  );

-- =============================================
-- 2. DROP COLUMN trip_pois.hours
-- =============================================
-- SQLite 3.35.0+ 支援 ALTER TABLE DROP COLUMN（D1 supported）。
-- col 是普通 TEXT，無 PK/UNIQUE/FK 限制，可直接 drop。
--
ALTER TABLE trip_pois DROP COLUMN hours;

-- =============================================
-- 3. ANALYZE
-- =============================================

ANALYZE pois;
ANALYZE trip_pois;
