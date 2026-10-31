-- Migration 0042: trip_days 加 title column
--
-- Section 4.3 (terracotta-mockup-parity-v2)：DaySection hero「area」改為 day title
-- 可由 user / AI 命名（例：「Day 3 · 美瑛拼布之路」「探索那霸老街」）。trip_days
-- 既有 `label` 欄存「區域」(例：「美瑛」)；title 是更高 level 的 user-facing
-- 標題，nullable 保留 fallback chain (title → label → 「Day N」)。
--
-- Backwards-compat：既有 row title = NULL，render 自動 fallback 到 label / Day N
-- 不會 break。Day title 編輯 UI 留下個 PR (PATCH /api/trips/:id/days/:num)。

ALTER TABLE trip_days ADD COLUMN title TEXT;
