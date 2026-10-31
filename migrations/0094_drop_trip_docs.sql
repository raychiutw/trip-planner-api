-- Migration 0094: DROP trip_docs + trip_doc_entries（trip_docs 退場第 2 步）
--
-- 內容已由 0093 搬進 trip_pretrip_notes。這裡把兩張表拿掉。
--
-- ## ⚠️ 部署順序（DROP 類，跟 additive 相反）
--
-- **code 先上線，DROP 後套。** 反過來會在 pre-migration 視窗讓仍在讀 trip_docs 的
-- 舊 code 撞 `no such table`。正確順序：
--   1. 套 0093（搬遷）
--   2. merge + auto-deploy（讀寫 trip_docs 的 code 全部下架）
--   3. owner 在筆記頁確認 102 筆看得到
--   4. 才套 0094
-- 這也是 DROP 排在驗證之後的原因 —— 第 3 步發現搬錯還有回頭路。
--
-- ## FK 順序
--
-- trip_doc_entries.doc_id → trip_docs(id) ON DELETE CASCADE。**先刪 children 再刪
-- parent**：直接 DROP trip_docs 會觸發 CASCADE（migrations/0047 記著 D1 上這件事
-- 造成過 prod 資料全失），雖然這裡兩張都要刪、結果相同，但顯式順序讓意圖清楚、
-- 也不依賴 CASCADE 行為。
--
-- trip_docs 沒有其他表指向它（唯一的 children 就是 trip_doc_entries）。
--
-- ## Rollback
--
-- 見 rollback/0094_drop_trip_docs_rollback.sql —— 只重建空表結構，**資料不回來**
-- （已搬進 trip_pretrip_notes）。真要救原始列請從 D1 time-travel bookmark 撈。

DROP TABLE IF EXISTS trip_doc_entries;
DROP TABLE IF EXISTS trip_docs;
