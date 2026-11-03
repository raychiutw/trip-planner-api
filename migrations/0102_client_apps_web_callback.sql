-- tripline-web 登記 web 的 Google 登入回跳網址（母 spec：trip-planner.flutter#525、票 #526）。
-- redirect_uri 一律精確比對，所以回跳網址要登記在 client_apps.redirect_uris；不做任何依 client_id 的豁免。
--
-- 冪等：已含就不再加；保留原本已登記的網址。只動 tripline-web，其他 client 與其他欄位不受影響。
-- 前一版（0099）登記的是 '[]'；json_valid 擋掉格式壞掉的值，避免 json_insert 對壞資料出錯。

UPDATE client_apps
SET redirect_uris = json_insert(redirect_uris, '$[#]', 'https://trip-planner-dby.pages.dev/auth/callback'),
    updated_at = datetime('now')
WHERE client_id = 'tripline-web'
  AND json_valid(redirect_uris)
  AND json_type(redirect_uris) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(client_apps.redirect_uris) WHERE value = 'https://trip-planner-dby.pages.dev/auth/callback');
