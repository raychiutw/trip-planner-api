-- 0090 — 既有帳號的個資條款同意標記為「沿用」
--
-- owner 決策（2026-07-21）：既有使用者回填同意紀錄，不另做補問流程。
--
-- ⚠ 版本字串刻意標記 `-grandfathered`，不與真實同意共用同一個值。
--
--   migration 0088 加這兩欄的唯一目的是「留下誰同意過的證據」。若把沿用寫成
--   跟實際點過同意一模一樣的紀錄，這個欄位就失去證據價值 —— 日後被監管或
--   使用者問起「他何時同意的」，我們會答不出來，也分不清哪些是真的。
--
--   標記之後兩者仍然分得開：
--     privacy_policy_version = '2026-07-20'               → 註冊時實際勾選同意
--     privacy_policy_version = '2026-07-20-grandfathered' → 本次沿用標記
--
--   查真實同意者：WHERE privacy_policy_version NOT LIKE '%-grandfathered'
--
-- 沿用的依據寫在隱私權政策的「政策變更」章節（同一批變更）：明示自
-- 2026-07-20 版起於註冊流程要求同意，在此之前建立的帳號屬沿用，繼續使用
-- 即視為接受。沒有那段揭露，這裡的時間戳就只是一個沒有依據的值。
--
-- 只更新 privacy_consent_at IS NULL 的列：
--   1. 冪等 —— 重跑不會動到任何已有紀錄；
--   2. 不覆寫 —— v2.57.0 上線後真正勾選同意而註冊的人，紀錄保持原樣。

UPDATE users
SET privacy_consent_at     = '2026-07-21T00:00:00Z',
    privacy_policy_version = '2026-07-20-grandfathered'
WHERE privacy_consent_at IS NULL;
