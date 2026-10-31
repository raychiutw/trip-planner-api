-- Migration 0095: 清掉建立在「已取消的 $200 抵免」上的三筆 Google Maps 設定
--
-- ## Why
--
-- Google 於 **2025-03 取消 $200/月 Maps 抵免**，改成各 SKU 各自的免費月額度
-- （Text Search 等 Enterprise tier 1K/月、Essentials 10K/月）。監控端早就跟著改了
-- —— daily-check 與 google-quota-monitor 現在算的是 free-cap headroom %，不是
-- $ vs 預算。但 app_settings 裡還躺著三筆舊模型的 key，而
-- `/api/admin/maps-settings` 把它們原封不動回出去：
--
--   google_maps_budget_usd            = 200   ← 幽靈預算，0 個決策消費者
--   google_maps_unlock_threshold_pct  = 50    ← 0 個消費者（它要驅動的「daily-check
--                                                自動解鎖」從未實作 —— maps-unlock.ts
--                                                的 docstring 那句宣稱是錯的，已修）
--   google_maps_lock_threshold_pct    = 90    ← 有消費者，但兩端都是 `|| 90` fallback
--
-- 任何讀那支 API 的人（或 agent）會以為還有一筆 $200 預算在管控成本。這不是無害的
-- 殘留 —— 它會讓人對「現在到底靠什麼擋暴衝帳單」產生錯誤認知。
--
-- ## 這支 migration 不會弄壞 kill switch
--
-- kill switch 本身靠 `google_maps_locked` / `_locked_reason` / `_locked_at` 三筆，
-- **不在刪除範圍**。90% critical 門檻改寫死成 scripts/lib/google-maps-quota.js 的
-- `CRITICAL_PCT`（與 google-quota-monitor.ts 同步，drift test 守著）。
--
-- ## 部署順序
--
-- 這是 DELETE 不是 DROP，且讀取端在同一支 PR 一起下架。任一順序都安全：
--   - 先套：舊 code 的 `|| 200` / `|| 90` / `|| 50` fallback 會頂著
--   - 後套：新 code 根本不讀這三個 key
--
-- ## Rollback
--
-- 見 rollback/0095_...：把三筆值寫回去。⚠️ 但 code 已不讀它們，寫回去只是讓
-- `/api/admin/maps-settings` 的舊回應形狀能重現，不會改變任何行為。

DELETE FROM app_settings WHERE key IN (
  'google_maps_budget_usd',
  'google_maps_lock_threshold_pct',
  'google_maps_unlock_threshold_pct'
);
