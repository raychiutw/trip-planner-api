-- 第一方 client 旗標：只有第一方 client（自家 web／行動 app）可以用密碼直接換 authorization code。
-- 預設 0：新註冊的第三方 client 一律不是第一方，必須走跳轉授權與同意流程。
ALTER TABLE client_apps ADD COLUMN first_party INTEGER NOT NULL DEFAULT 0 CHECK (first_party IN (0, 1));

-- web SPA 自己的 public client（web 改用 bearer token 後需要）。不註冊 redirect_uri：第一方直接換 code，不走跳轉。
INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, app_description, redirect_uris, allowed_scopes, status)
VALUES ('tripline-web', NULL, 'public', 'Tripline Web', 'Official Tripline web app', '[]',
  '["openid","profile","email","offline_access"]', 'active')
ON CONFLICT(client_id) DO NOTHING;

UPDATE client_apps SET first_party = 1
WHERE client_id IN ('tripline-web', 'tripline-mobile', 'tripline-mobile-uat', 'tripline-mobile-dev');
