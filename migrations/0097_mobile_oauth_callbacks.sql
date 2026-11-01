-- 註冊精確的 HTTPS app-link callback，且不覆蓋營運端自行管理的 redirect URI。
-- 由 runtime 環境政策選出對應的 client / URI；
-- 既有的 loopback 只保留給本機開發使用。

UPDATE client_apps
SET redirect_uris = json_insert(redirect_uris, '$[#]', 'https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback'),
    updated_at = datetime('now')
WHERE client_id = 'tripline-mobile'
  AND json_valid(redirect_uris)
  AND NOT EXISTS (
    SELECT 1 FROM json_each(client_apps.redirect_uris)
    WHERE value = 'https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback'
  );

INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, app_description, redirect_uris, allowed_scopes, status)
VALUES ('tripline-mobile-uat', NULL, 'public', 'Tripline Mobile UAT', 'Tripline Flutter UAT',
  '["https://mobile-callback.trip-planner-dby.pages.dev/uat/oauth/callback"]',
  '["openid","profile","email","offline_access"]', 'active')
ON CONFLICT(client_id) DO NOTHING;

INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, app_description, redirect_uris, allowed_scopes, status)
VALUES ('tripline-mobile-dev', NULL, 'public', 'Tripline Mobile Development', 'Tripline Flutter local development',
  '["http://127.0.0.1:8765"]',
  '["openid","profile","email","offline_access"]', 'active')
ON CONFLICT(client_id) DO NOTHING;
