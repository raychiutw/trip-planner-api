-- mobile OAuth callback 搬到 web 主站（raychiutw/trip-planner#1482）：只追加新的精確 HTTPS callback。
-- 過渡期新舊並存：已發佈的 App 仍用 0097 登記的舊 callback，這裡一律不移除、不覆寫。
--
-- 冪等：已含就不再加；保留營運端自行登記的值。只動 tripline-mobile（production）與 tripline-mobile-uat（UAT），
-- 且各自只加自己環境的那一條，不跨環境；dev 與其他 client 不受影響。
-- json_valid／json_type 擋掉格式壞掉的值，避免 json_insert 對壞資料出錯（比照 0103）。

UPDATE client_apps
SET redirect_uris = json_insert(redirect_uris, '$[#]', 'https://trip-planner-dby.pages.dev/mobile/oauth/callback'),
    updated_at = datetime('now')
WHERE client_id = 'tripline-mobile'
  AND json_valid(redirect_uris)
  AND json_type(redirect_uris) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(client_apps.redirect_uris) WHERE value = 'https://trip-planner-dby.pages.dev/mobile/oauth/callback');

UPDATE client_apps
SET redirect_uris = json_insert(redirect_uris, '$[#]', 'https://trip-planner-dby.pages.dev/mobile/uat/oauth/callback'),
    updated_at = datetime('now')
WHERE client_id = 'tripline-mobile-uat'
  AND json_valid(redirect_uris)
  AND json_type(redirect_uris) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(client_apps.redirect_uris) WHERE value = 'https://trip-planner-dby.pages.dev/mobile/uat/oauth/callback');
