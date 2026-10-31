-- 移除 tunnel/webhook 相關結構

-- 1. 刪除 webhook_logs 表
DROP TABLE IF EXISTS webhook_logs;

-- 2. requests 表移除 webhook_status 欄位（D1 支援 ALTER TABLE DROP COLUMN）
ALTER TABLE requests DROP COLUMN webhook_status;
