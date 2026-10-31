-- Migration 0056: trip_entries.time → start_time / end_time 拆分
--
-- ## Background
--
-- v2.2 起 trip_entries.time 是 free-form TEXT，混合「`HH:MM`」（單一時間）跟
-- 「`HH:MM-HH:MM`」（區間）兩種格式。前端 parseTimeRange() 解析，但編輯成本
-- 高（沒法獨立改開始/結束），缺少 schema-level constraint。
--
-- v2.26.0 EditEntryPage（mockup 2026-05-11）需要兩個獨立 input 編 startTime /
-- endTime，schema 層拆分讓 PATCH 變單純 + 加 NOT NULL/format guard 不再可能。
--
-- ## Scope
--
-- 1. ADD COLUMN start_time TEXT  -- nullable，向後相容（既有 NULL 仍 NULL）
-- 2. ADD COLUMN end_time   TEXT
-- 3. Backfill：把既有 time 拆 start_time / end_time
--    - "HH:MM-HH:MM" → start_time = 前段, end_time = 後段
--    - "HH:MM"       → start_time = HH:MM, end_time = NULL
--    - NULL / ''      → 兩欄都 NULL
-- 4. **不 drop** time（dual-read 觀察期；後續 migration 0057 再 drop）
--
-- ## Deploy 順序
--
-- 與 v2.25.4（migration 0054 ADD COLUMN price）一致：
--   1. **Apply migration 先**（兩個新欄為 nullable，舊 backend 不會 SELECT 報錯）
--   2. Merge PR + CF Pages 部署 backend（新 backend dual-write start_time/end_time + time）
--
-- 跟 v2.25.5 (DROP COLUMN) 順序相反：ADD COLUMN 是 additive，先 apply 安全。
-- D1 Pages 自動 deploy 工作流會 parallel 跑 migration vs CF Pages build，先後
-- 都不會中斷 prod。
--
-- =============================================
-- 1. ADD COLUMN
-- =============================================

ALTER TABLE trip_entries ADD COLUMN start_time TEXT;
ALTER TABLE trip_entries ADD COLUMN end_time TEXT;

-- =============================================
-- 2. Backfill from existing time field
-- =============================================
-- 規則：
--   "HH:MM-HH:MM" → start = substr(1, pos('-')-1), end = substr(pos('-')+1)
--   "HH:MM"       → start = time, end = NULL
--   NULL / ''      → 兩欄 NULL（不動）

-- Range case: contains '-' (e.g., "12:00-13:30")
UPDATE trip_entries
SET
  start_time = trim(substr(time, 1, instr(time, '-') - 1)),
  end_time   = trim(substr(time, instr(time, '-') + 1))
WHERE time IS NOT NULL
  AND time != ''
  AND instr(time, '-') > 0;

-- Single-time case: no '-' (e.g., "08:00")
UPDATE trip_entries
SET start_time = trim(time)
WHERE time IS NOT NULL
  AND time != ''
  AND instr(time, '-') = 0;

-- =============================================
-- 2b. Cleanup: NULL out malformed values
-- =============================================
-- Pathological legacy rows (e.g. time = "-", "12:00-", "abc-def") could leave
-- empty / non-conforming start_time / end_time. Clean those to NULL so the
-- backend's HH:MM regex defenders aren't hit by garbage on next PATCH.
-- GLOB pattern matches strict HH:MM zero-padded only.

UPDATE trip_entries
SET start_time = NULL
WHERE start_time = ''
   OR (start_time IS NOT NULL AND start_time NOT GLOB '[0-2][0-9]:[0-5][0-9]');

UPDATE trip_entries
SET end_time = NULL
WHERE end_time = ''
   OR (end_time IS NOT NULL AND end_time NOT GLOB '[0-2][0-9]:[0-5][0-9]');

-- =============================================
-- 3. ANALYZE
-- =============================================

ANALYZE trip_entries;
