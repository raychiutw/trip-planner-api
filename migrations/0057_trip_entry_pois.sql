-- Migration 0057: trip_entry_pois junction table（multi-POI per entry, master + alternates）
--
-- ## Background
--
-- 自 v2.2 migration 0026 起，trip_entries.poi_id 是 entry 對 pois master 的 1:1 FK。
-- v2.27.0 升級成 1:N — 每個 entry 有 1 個 master + 0-N alternates，全走新 junction
-- table trip_entry_pois。
--
-- 設計決策（office-hours 2026-05-11 + autoplan 2026-05-11）：
--   - 不開 role enum，sort_order=1 即 master（user explicit signal）
--   - At-least-one master invariant：backend enforce
--   - UNIQUE (entry_id, sort_order) 避免雙 master
--   - UNIQUE (entry_id, poi_id) 避免同 POI 在同 entry 兩種角色
--   - updated_at 作為 OCC version（Codex Finding #1 CRITICAL — dual-write race）
--   - trip_entries.poi_id 保留作 denormalized cache（Phase 1 dual-write 過渡期）
--
-- ## Phase 1 (本 migration)
--
-- 1. CREATE TABLE trip_entry_pois
-- 2. CREATE 2 indexes（entry composite + poi single）
-- 3. Backfill：把既有 trip_entries.poi_id IS NOT NULL 灌成 sort_order=1
--
-- ## Phase 2 (migration 0058，下一 release)
--
-- 觀察期 ≥ 1 release + 5 個 invariant smoke queries 全綠 + grep entry.poi_id clean
-- 之後 DROP COLUMN trip_entries.poi_id（rollback 預備：見 rollback/0058 倒回腳本）
--
-- ## Deploy 順序
--
-- 1. **Apply migration 先**（新 table 是 additive，舊 backend 不會 SELECT 報錯）
-- 2. Merge PR + CF Pages 部署 backend
--    - 新 backend 在 setMaster() helper 同步寫 trip_entry_pois + trip_entries.poi_id
--    - GET /trips/:id dual-read（優先 trip_entry_pois.sort_order=1，fallback 到
--      trip_entries.poi_id + 即時 INSERT 補資料）
--
-- =============================================
-- 1. CREATE TABLE
-- =============================================

CREATE TABLE trip_entry_pois (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL REFERENCES trip_entries(id) ON DELETE CASCADE,
  poi_id      INTEGER NOT NULL REFERENCES pois(id) ON DELETE RESTRICT,
  sort_order  INTEGER NOT NULL CHECK (sort_order >= 1),
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entry_id, sort_order),
  UNIQUE (entry_id, poi_id)
);

-- =============================================
-- 2. Indexes
-- =============================================
-- (entry_id, sort_order) composite covers:
--   - GET /trips/:id master lookup (WHERE entry_id=? AND sort_order=1)
--   - alternates list ORDER BY sort_order
-- single poi_id index covers:
--   - reverse lookup「這個 POI 在哪些 entries 用過」（未來 analytics）

CREATE INDEX idx_trip_entry_pois_entry ON trip_entry_pois(entry_id, sort_order);
CREATE INDEX idx_trip_entry_pois_poi ON trip_entry_pois(poi_id);

-- =============================================
-- 3. Backfill from existing trip_entries.poi_id
-- =============================================
-- 規則：
--   trip_entries.poi_id IS NOT NULL → INSERT (entry_id, poi_id, sort_order=1)
--   trip_entries.poi_id IS NULL     → skip（後續若需要這個 entry 有 master，
--                                            backend 透過 setMaster() 補）
--
-- 取 trip_entries.updated_at 作 added_at preserve 原時間戳

INSERT INTO trip_entry_pois (entry_id, poi_id, sort_order, added_at, updated_at)
SELECT
  id,
  poi_id,
  1,
  COALESCE(updated_at, datetime('now')),
  datetime('now')
FROM trip_entries
WHERE poi_id IS NOT NULL;

-- =============================================
-- 4. ANALYZE
-- =============================================

ANALYZE trip_entry_pois;
