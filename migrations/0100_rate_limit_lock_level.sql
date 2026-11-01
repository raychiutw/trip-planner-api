-- 階梯式鎖定要記住「目前是第幾次鎖」：第一次鎖較短，之後鎖較長（見 bumpTieredLock）。
-- 預設 0：既有的 bucket 與舊入口的寫入（不指定此欄）行為不變。
ALTER TABLE rate_limit_buckets ADD COLUMN lock_level INTEGER NOT NULL DEFAULT 0;
