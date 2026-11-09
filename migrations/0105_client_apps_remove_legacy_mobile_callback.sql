-- 退役舊 mobile OAuth callback（mobile-callback 分支別名；raychiutw/trip-planner#1663，承接 #1482）：
-- 從 tripline-mobile、tripline-mobile-uat 的 redirect_uris 移除 0097 登記的兩條舊網址。
--
-- 只有 UPDATE，不刪表、不刪列：以 json_each 過濾掉指定的兩個值，其餘值（主站 callback、loopback、營運端自加）原樣保留；
-- 不動其他 client。冪等：已不含舊值就不符合 EXISTS，不會改動。
-- json_valid／json_type 擋掉格式壞掉的值（比照 0103／0104）。
-- 影響：仍用舊 callback 的舊版 App（0.38.0 以前）登入會壞，owner 已於 2026-11-09 接受。

UPDATE client_apps
SET redirect_uris = (
      SELECT json_group_array(value) FROM json_each(client_apps.redirect_uris)
      WHERE value NOT IN (
        'https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback',
        'https://mobile-callback.trip-planner-dby.pages.dev/uat/oauth/callback'
      )
    ),
    updated_at = datetime('now')
WHERE client_id IN ('tripline-mobile', 'tripline-mobile-uat')
  AND json_valid(redirect_uris)
  AND json_type(redirect_uris) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(client_apps.redirect_uris)
    WHERE value IN (
      'https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback',
      'https://mobile-callback.trip-planner-dby.pages.dev/uat/oauth/callback'
    )
  );
