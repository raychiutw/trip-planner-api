ALTER TABLE requests ADD COLUMN webhook_status TEXT DEFAULT NULL;
-- NULL = 舊資料或未觸發 webhook
-- 'sent' = webhook 成功送出
-- 'failed' = webhook 失敗（tunnel 不通）
-- 'no_tunnel' = KV 中無 TUNNEL_URL
