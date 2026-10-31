-- Migration 0078: 備註 source of truth 從 trip_entries.note → master trip_entry_pois.note + DROP COLUMN
--
-- ## Background
--
-- 「備註」原本是 entry-level（trip_entries.note，整個停留點共用一條）。v2.27.0 起一個
-- 停留點可有 1 正選（master，trip_entry_pois.sort_order=1）+ N 備選（alternate，sort_order>1），
-- 但每個候選 POI 各自的備註只有「新增時可帶」、沒有 UPDATE 路徑，且 entry-level 備註與
-- per-POI 備註並存造成語意重疊。
--
-- 本案（方案 B，單一 PR 直接 DROP）把備註語意收斂為 per-(entry, poi)：
--   - 「正選備註」= master row（sort_order=1）的 trip_entry_pois.note
--   - 新增 PATCH /api/trips/:id/entries/:eid/pois/:poiId 端點做 per-POI note UPDATE
--   - read path 早已由 fetchEntryPoisByEntries（_merge.ts）surface tep.note 到 master/alternates/stopPois
--
-- ## Scope
--
-- 1. Backfill：把既有 trip_entries.note 合併進對應 entry 的 master trip_entry_pois.note
--    （合併策略見下）。只處理 trip_entries.note 非空者；entry 無 master row → 略過（孤兒
--    備註無處可掛，等同丟棄——此情境罕見，多為無 POI 的 placeholder entry）。
-- 2. DROP COLUMN trip_entries.note（無 referencing index，不需先 DROP INDEX）。
-- 3. ANALYZE。
--
-- ## 合併策略（design D5）
--
--   - master note 空（NULL 或 '') → SET = trip_entries.note
--   - master note 與 entry note 皆非空 → SET = trip_entry_pois.note || char(10) || trip_entries.note
--     （換行串接，poi note 在前；避免覆蓋既有 per-POI 備註造成資料遺失）
--
-- ## Deploy 順序（hard rule）
--
-- 順序：merge PR → backend deploy（已 cutover，不再讀寫 trip_entries.note）→ apply 此 migration。
-- 不可顛倒：先 DROP COLUMN → in-flight 舊 backend 對 trip_entries.note 的 INSERT/SELECT
-- 會 "no such column: note" fail。所有 6 個建立路徑（PUT /days、POST /entries、copy、
-- share clone、import、poi-favorites add-to-trip）+ PATCH /entries（ALLOWED_FIELDS/textFields）
-- 必須在此 migration 套用前完成 cutover（同 PR）。
--
-- Rollback: rollback/0078_drop_trip_entries_note_rollback.sql 補回 nullable note column
-- （資料無法還原——backfill 已把值併進 master poi note；rollback 僅為 schema parity
-- 讓 emergency cutback 期間舊 backend 不 5xx）。

-- =============================================
-- 1. Backfill trip_entries.note → master trip_entry_pois.note
-- =============================================
-- 只 UPDATE「有對應 master row」且「該 entry 的 trip_entries.note 非空」的 master rows。
-- 用 correlated subquery 取該 master 所屬 entry 的 entry-level note。
-- COALESCE(NULLIF(tep.note,''), '') 把 master 既有 note 的 NULL/'' 都視為空。
-- 串接時若 master note 空 → 直接用 entry note（不前置換行）；否則 poi note + '\n' + entry note。
--
UPDATE trip_entry_pois
SET note = (
  SELECT
    CASE
      WHEN COALESCE(NULLIF(trip_entry_pois.note, ''), '') = ''
        THEN te.note
      ELSE trip_entry_pois.note || char(10) || te.note
    END
  FROM trip_entries te
  WHERE te.id = trip_entry_pois.entry_id
),
updated_at = datetime('now')
WHERE trip_entry_pois.sort_order = 1
  AND EXISTS (
    SELECT 1
    FROM trip_entries te2
    WHERE te2.id = trip_entry_pois.entry_id
      AND COALESCE(NULLIF(te2.note, ''), '') <> ''
  );

-- =============================================
-- 2. DROP COLUMN trip_entries.note
-- =============================================
-- 無 index reference trip_entries.note（grep migrations 確認），可直接 DROP。
--
ALTER TABLE trip_entries DROP COLUMN note;

-- =============================================
-- 3. ANALYZE
-- =============================================

ANALYZE trip_entries;
ANALYZE trip_entry_pois;
