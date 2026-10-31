-- Migration 0075: DROP trip_lodging_days junction table
-- v2.34.46 PR46: User feedback — 旅館完全不再關聯 Day。整個 junction 模型 + 多 day 設計 ripped out。
--
-- PR44 (migration 0074) 引入 junction 模型把 trip_lodgings.day_id 改成 M:N。
-- User 後續決定旅館不需要關聯 day（資訊頁面用途、不影響 timeline），整套移除。
--
-- 此 migration 只 DROP junction table；trip_lodgings 本身在 0074 已拔 day_id column
-- 不需 ALTER。

DROP INDEX IF EXISTS idx_trip_lodging_days_day_id;
DROP TABLE IF EXISTS trip_lodging_days;
