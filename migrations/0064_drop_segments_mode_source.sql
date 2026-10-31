-- Migration 0064: DROP COLUMN trip_segments.mode_source
--
-- ## Background
--
-- v2.24.0 加 `mode_source` ('auto' | 'user') 當 user override lock — 任何 mode
-- 被 user 從 UI 改過後 `recompute-travel` 永遠跳過。實際 UX：使用者改完 driving 後
-- 想再 trigger 重新計算就只能砍 segment 重建。
--
-- v2.30.0 改 model：
--   - mode='transit'   → user 手填 min（Japan Routes 無 transit 資料），不重算
--   - mode='driving'   → 一律 Google Routes 重算
--   - mode='walking'   → 一律 Google Routes 重算
--
-- 「user 鎖定」概念由 mode='transit' 自然代理 — 切回 driving / walking 就 trigger
-- 重算。`mode_source` 不再需要。
--
-- ## Deploy 順序（hard rule）
--
-- 1. Apply migration → trip_segments 無 mode_source col
-- 2. Pages deploy 新 backend（不讀寫 mode_source）
--
-- 順序顛倒（Pages 先 deploy）→ 新 backend INSERT trip_segments 不會 fail，因為
-- mode_source 有 DEFAULT 'auto'，但 OLD backend SELECT mode_source 不會 fail。
-- 真實 race window: migration 後 30-90s 內 OLD backend SELECT 會回 SQL error。
-- 已知短窗，accept。

ALTER TABLE trip_segments DROP COLUMN mode_source;

ANALYZE trip_segments;
