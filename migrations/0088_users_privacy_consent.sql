-- 0088 — users 加個資條款同意紀錄
--
-- owner 決策（2026-07-20）：「保留資料，但建立帳號要客戶同意個資條款，
-- 如果刪除帳號會去識別化」。
--
-- 為什麼需要欄位而非只在前端擋：純前端勾選框擋不住直接打 API，且 DB 裡留不下
-- 任何「這個人同意過」的證據。真被監管或爭議問起時，手上要有時間戳。
--
-- 為什麼要記版本：政策改版後，沒有版本欄位就無法得知某位使用者當初同意的是哪一版，
-- 也無法判斷誰需要重新同意。
--
-- ⚠ 既有使用者這兩欄為 NULL —— 代表「無同意紀錄」，不是「已同意」。
--   要不要要求既有使用者補同意是獨立決策（見
--   docs/design-sessions/2026-07-20-store-readiness-checkpoint.md）。
--   欄位刻意**可為 NULL**，就是為了讓「沒有紀錄」與「已同意」在資料上可區分。

ALTER TABLE users ADD COLUMN privacy_consent_at TEXT;
ALTER TABLE users ADD COLUMN privacy_policy_version TEXT;

-- 查「哪些帳號尚無同意紀錄」用（補同意流程與稽核都會問這題）
CREATE INDEX IF NOT EXISTS idx_users_privacy_consent_at ON users(privacy_consent_at);
