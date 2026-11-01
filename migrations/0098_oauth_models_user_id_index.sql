-- 帳號抹除用 json_extract(payload, '$.user_id') 找 token 類資料（access／refresh token 等），
-- 原本 oauth_models 只有 $.uid 與 $.grantId 的表達式索引，沒有 $.user_id，
-- 且 OR 條件讓 $.uid 的索引也派不上用場，每次刪帳號都整表解析 JSON。
-- 只新增索引，可重複套用；對舊程式碼完全相容。
CREATE INDEX IF NOT EXISTS idx_oauth_models_user_id ON oauth_models(json_extract(payload, '$.user_id'));
