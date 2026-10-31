-- Migration 0054: pois.price phase 1 — column rename trip_pois.price → pois.price
--
-- ## Phase 1 of 2 (phase 2 = migration 0055, future PR)
--
-- Phase 1 = ADD COLUMN pois.price + COPY existing trip_pois.price → pois.price
-- Phase 2 = DROP COLUMN trip_pois.price（觀察期後）
--
-- ## 為什麼搬 price 到 pois master
--
-- price 是餐廳客觀屬性（菜單定價），不是 trip-specific 主觀資料。原本放
-- trip_pois override 是 schema misalignment — 同一家餐廳在不同行程顯示不同
-- 價位毫無意義。搬到 pois master 讓多個 trip 共用同一筆 price 資料。
--
-- ## Cutover strategy
--
-- Backend 同 PR cutover：
--   - WRITE: 只寫 pois.price（findOrCreatePoi + PATCH /pois 接受 price）
--   - READ: COALESCE(pois.price, trip_pois.price) 雙讀（dual-read 保險）
--   - PATCH /trip-pois 移除 'price' from ALLOWED_FIELDS（不再支援 trip_pois.price 寫入）
--
-- Migration 0055（觀察期後另一 PR）才 DROP COLUMN trip_pois.price。
--
-- ## Idempotency
--
-- ADD COLUMN IF NOT EXISTS 不可用 SQLite，但 ALTER 可重跑會 error。
-- INSERT...SELECT 用 WHERE pois.price IS NULL 確保不重複 copy。
--
-- =============================================
-- 1. ADD COLUMN pois.price
-- =============================================

ALTER TABLE pois ADD COLUMN price TEXT;

-- =============================================
-- 2. COPY trip_pois.price → pois.price
-- =============================================
-- 規則：
--   - 一個 pois 可能對應多筆 trip_pois（不同 trip 共用同 POI）
--   - 多筆 trip_pois.price 衝突時，取最新 updated_at 的（MAX 取一）
--   - 只 copy pois.price 為 NULL 的，避免 idempotency 風險
--
UPDATE pois
SET price = (
  SELECT tp.price
  FROM trip_pois tp
  WHERE tp.poi_id = pois.id
    AND tp.price IS NOT NULL
    AND tp.price != ''
  ORDER BY tp.updated_at DESC
  LIMIT 1
)
WHERE pois.price IS NULL
  AND EXISTS (
    SELECT 1 FROM trip_pois tp
    WHERE tp.poi_id = pois.id
      AND tp.price IS NOT NULL
      AND tp.price != ''
  );

-- =============================================
-- 3. ANALYZE
-- =============================================

ANALYZE pois;
