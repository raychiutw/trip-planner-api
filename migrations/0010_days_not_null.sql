-- Migration 0010: days table — date/day_of_week/label NOT NULL DEFAULT ''
-- 不使用 recreate table 策略（DROP TABLE 會觸發 ON DELETE CASCADE 刪除所有子表資料）
-- 改用 UPDATE + 驗證方式確保欄位不含 NULL

-- Step 1: 把現有 null 值補上預設
UPDATE days SET date = '' WHERE date IS NULL;
UPDATE days SET day_of_week = '' WHERE day_of_week IS NULL;
UPDATE days SET label = '' WHERE label IS NULL;

-- Step 2: 驗證無 NULL 值（D1 不支援 ALTER COLUMN 加 NOT NULL，僅靠 API 層 _validate.ts 攔截）
-- 若未來 D1 支援 ALTER COLUMN SET NOT NULL，可再補上 DDL
