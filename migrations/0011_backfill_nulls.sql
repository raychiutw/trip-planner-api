-- Migration 0011: backfill NULL 值於 days 表
-- 被 FK ON DELETE CASCADE 引用的表（days 被 hotels/entries 引用）不能 DROP TABLE，
-- 改用 UPDATE 方式 backfill NULL 值 + API 層驗證雙重保護。

-- Step 1: backfill days.date NULL 值
-- 邏輯：找同 trip 中任一有 date 的 day，用 day_num 差值推算缺失日期
-- SQLite date() 函式可計算日期加減，格式 date(base_date, '+N days')
UPDATE days
SET date = (
  SELECT date(ref.date, '+' || (days.day_num - ref.day_num) || ' days')
  FROM days AS ref
  WHERE ref.trip_id = days.trip_id
    AND ref.date IS NOT NULL
    AND ref.date != ''
    AND ref.date LIKE '____-__-__'
  ORDER BY ref.day_num ASC
  LIMIT 1
)
WHERE date IS NULL OR date = '';

-- Fallback: 若整個 trip 都沒有有效 date（上面的 subquery 找不到任何 ref），用 trip 的 created_at 推算
UPDATE days SET date = date(
  (SELECT COALESCE(t.created_at, '2026-01-01') FROM trips t WHERE t.id = days.trip_id),
  '+' || (days.day_num - 1) || ' days'
)
WHERE date IS NULL OR date = '';

-- Step 2: backfill days.day_of_week NULL 值
-- 根據 date 推算星期（SQLite strftime %w: 0=Sunday, 1=Monday...6=Saturday）
-- 對應中文星期表示
UPDATE days
SET day_of_week = CASE strftime('%w', date)
  WHEN '0' THEN '日'
  WHEN '1' THEN '一'
  WHEN '2' THEN '二'
  WHEN '3' THEN '三'
  WHEN '4' THEN '四'
  WHEN '5' THEN '五'
  WHEN '6' THEN '六'
  ELSE '一'
END
WHERE (day_of_week IS NULL OR day_of_week = '')
  AND date IS NOT NULL
  AND date != ''
  AND date LIKE '____-__-__';

-- Fallback: 如果仍有 NULL（date 無法解析）則根據 day_num 推算星期
UPDATE days SET day_of_week = CASE ((days.day_num - 1) % 7)
  WHEN 0 THEN '一'
  WHEN 1 THEN '二'
  WHEN 2 THEN '三'
  WHEN 3 THEN '四'
  WHEN 4 THEN '五'
  WHEN 5 THEN '六'
  WHEN 6 THEN '日'
  ELSE '一'
END
WHERE day_of_week IS NULL;

-- Step 3: backfill days.label NULL 值
-- label 為行程天的短標題，無法從其他欄位推算，使用 'Day N' 作為預設值
UPDATE days
SET label = 'Day ' || day_num
WHERE label IS NULL OR label = '';

-- Fallback: 確保所有 label 都不為 NULL（理論上上面已處理，此為最終防線）
UPDATE days SET label = 'Day ' || day_num WHERE label IS NULL;

-- Step 4: 驗證 — 確認無 NULL 值
-- v2.33.60 round 14 note: 以下 SELECT COUNT(*) 在 `wrangler d1 migrations apply` 下
-- output 被吃掉、無人讀到，「manual verify」comment 誤導但歷史 migration 不能再改 SQL
-- (已 apply prod + fresh DB rebuild 會跑此版本)。未來 migration 改用 D1 trigger RAISE
-- ABORT 機制做 post-condition assertion，新流程示範待 0070+。
-- 注意：D1 不支援 ASSERT，以下 SELECT 在執行後應回傳 0（可手動驗證用）
SELECT COUNT(*) as remaining_null_date FROM days WHERE date IS NULL OR date = '';
SELECT COUNT(*) as remaining_null_dow FROM days WHERE day_of_week IS NULL;
SELECT COUNT(*) as remaining_null_label FROM days WHERE label IS NULL;
