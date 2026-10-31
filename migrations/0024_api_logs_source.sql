-- 0024: api_logs 加 source 欄位
--
-- 為了讓 daily-check 能區分「scheduler infra 問題」「user 操作失敗」「anonymous 攻擊」
-- 等來源，middleware 寫入 4xx/5xx log 時會帶上 source 標籤。
--
-- source 值:
--   'scheduler'     — Mac Mini tripline-api-server（X-Tripline-Source: scheduler）
--   'companion'     — tp-request 排程 Claude session（X-Request-Scope: companion）
--   'service_token' — 其他 Service Token 呼叫（CF-Access-Client-Id + Secret）
--   'user_jwt'      — 瀏覽器使用者（CF_Authorization cookie）
--   'anonymous'     — 沒有 auth 的 public endpoint
--   NULL            — 歷史資料（24h 後透過 time filter 自然淘汰）
--
-- 不加 index：source 只在每天一次 aggregation 用到，既有的 idx_api_logs_created
-- (0007/0008) 已足夠。

ALTER TABLE api_logs ADD COLUMN source TEXT DEFAULT NULL;
