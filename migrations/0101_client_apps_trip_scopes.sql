-- 第一方 client（mobile 三環境 + web）登記行程 scope：trips:read、trips:write。
-- 資源伺服器的 hasTripScope 只看 token 上的 scope；token 的 scope 必須是 client 的 allowed_scopes 子集，
-- 所以要先在這裡登記，client 授權時才要得到（走標準 OAuth，沒有任何依 client_id 的豁免）。
--
-- 冪等：每個 scope 各自判斷「還沒有才附加」，重複套用不會重複加；保留原本的 scope 與其他欄位。
-- 只動這四個 client；第三方自助註冊的 client 不受影響（dev/apps 的 ALLOWED_USER_SCOPES 仍不含行程 scope）。
-- 部署順序：本 migration 要先於 App／web 新版（它們授權時會要求行程 scope）。

UPDATE client_apps
SET allowed_scopes = json_insert(allowed_scopes, '$[#]', 'trips:read'),
    updated_at = datetime('now')
WHERE client_id IN ('tripline-mobile', 'tripline-mobile-uat', 'tripline-mobile-dev', 'tripline-web')
  AND json_valid(allowed_scopes)
  AND NOT EXISTS (SELECT 1 FROM json_each(client_apps.allowed_scopes) WHERE value = 'trips:read');

UPDATE client_apps
SET allowed_scopes = json_insert(allowed_scopes, '$[#]', 'trips:write'),
    updated_at = datetime('now')
WHERE client_id IN ('tripline-mobile', 'tripline-mobile-uat', 'tripline-mobile-dev', 'tripline-web')
  AND json_valid(allowed_scopes)
  AND NOT EXISTS (SELECT 1 FROM json_each(client_apps.allowed_scopes) WHERE value = 'trips:write');
