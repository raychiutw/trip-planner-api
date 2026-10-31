-- v2.30.15: DROP pois.mapcode column
--
-- mapcode (Japan 8-digit car-navi location code) 在 terracotta UX redesign 中
-- 已決定整段 rip out — Google/Apple Map link 已涵蓋導航需求，mapcode chip 渲染
-- 在用戶 90%+ 場景沒實際使用，且 backend 至 frontend 整鏈維護成本不成比例。
--
-- Deploy 順序（避開 v2.30.0 mode_source DROP 學到的 race window）：
--   1. merge backend PR + deploy code（read 端不再依賴 mapcode column）
--   2. wait 60s for CF Pages propagation
--   3. apply migration（DROP COLUMN）
-- 順序顛倒會讓既有 backend `INSERT pois(mapcode) VALUES (?)` 觸發 SQL fail。
--
-- Rollback: rollback/0066_drop_pois_mapcode_rollback.sql adds back nullable column
-- (data loss — original mapcode values not preserved).

ALTER TABLE pois DROP COLUMN mapcode;
