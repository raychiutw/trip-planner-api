-- 0089 — 既有行程改為不公開
--
-- owner 決策（2026-07-21）：「將 prod 10 個 published 改為 0」。
--
-- 背景：前端建立行程時寫死 `published: 1`（v2.57.0 已移除），於是每個使用者
-- 新建的行程都立刻公開。使用者不會預期「建立行程」等於「發佈行程」。
-- v2.57.0 只改了**新建**的預設值，既有資料仍是 1，故需要這支補上。
--
-- ⚠ published 不只是「出現在公開清單」——它同時是 `/api/trips/:id/*` 的讀取
--   權限閘門（`functions/api/_auth.ts` requireTripReadAccess）。published=1 的
--   行程，任何人只要知道 tripId 就能匿名讀完整內容（含航班編號、訂房編號、
--   緊急聯絡人電話）。關掉之後：
--     - 共編者不受影響（走 trip_permissions，與 published 無關）
--     - `/s/:token` 分享連結不受影響（獨立路徑，不看 published）
--     - 僅「拿著 /trips/<id> 直接連結的匿名訪客」會失去存取，這正是本次意圖
--
-- 為什麼列出明確 ID 而不是 `UPDATE trips SET published = 0`：
--   1. 自我記錄 —— 一年後看這支，知道當時到底動了哪 10 筆；
--   2. 可逆 —— rollback 檔把同一組 ID 翻回去即可，blanket UPDATE 無從還原
--      「原本哪些是 1」；
--   3. 不誤傷 —— 若日後有人刻意公開某個行程，這支不會把它一併關掉。
--
-- 清單來源：2026-07-21 對 prod `GET /api/trips` 的實際回應（當時 published=1
-- 的全部 10 筆）。

UPDATE trips SET published = 0 WHERE id IN (
  'okinawa-trip-2026-HuiYun',  -- Hui Yun 的沖繩之旅（成員 2）
  'okinawa-trip-2026-Ray',     -- Ray 的沖繩之旅（成員 3）
  'trip-bp5o',                 -- 台北（成員 1）
  'trip-me4p',                 -- 東京（成員 1）
  'trip-g8we',                 -- 東京（成員 1）
  'trip-f73v',                 -- 東京（成員 1）
  'trip-m40m',                 -- 東京（成員 1）
  'trip-692q',                 -- 東京都（成員 3）
  'trip-3rlt',                 -- 琉球嶼（成員 2）
  'trip-is1n'                  -- 臺東（成員 1）
);
