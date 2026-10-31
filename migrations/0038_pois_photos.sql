-- Migration 0038: pois.photos JSON column（v2.12 Wave 3）
--
-- 目標：在 pois master 加 photos JSON 欄位，supply StopLightbox photo carousel。
-- 資料來源：Wikimedia Commons API（透過 scripts/populate-poi-photos.js 抓填）。
-- 後續 user upload 流程（v2.13+）也寫到同一欄位。
--
-- Schema:
--   photos: JSON array of { url, caption?, source?, thumbUrl?, attribution? }
--   nullable — 已存在的 pois 還沒抓照片時為 NULL。
--
-- StopLightbox 行為：
--   - photos NULL or [] → 顯示「📷 照片功能即將推出」 placeholder
--   - photos.length ≥ 1 → 渲染 carousel（◀ ▶ + 分頁點）
--
-- 不加 NOT NULL 因為：
--   1. existing rows backfill 是 async（populate-script 跑可能要小時）
--   2. 私房景點 / 自訂 POI 可能 Wikimedia 找不到對應條目，留 NULL 是常態
--   3. CDN 圖片有 hotlink 風險，未來可能改成 user upload，schema 要保持彈性

ALTER TABLE pois ADD COLUMN photos TEXT;
