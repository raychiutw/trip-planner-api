-- v2.40.0: trip_shares.anonymous — 匿名分享 toggle (PR2 完整管理面板)
--
-- 公開分享頁 hero 預設顯「由 {owner display_name} 分享給你」。anonymous=1 時
-- 改顯「有人分享了一份行程給你」(buildShareMeta 回 sharedBy='')，讓 owner 可
-- 選擇不露名分享。per-link 設定（同行程不同連結可不同）。
ALTER TABLE trip_shares ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
