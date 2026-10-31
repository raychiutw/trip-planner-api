-- Migration 0027: Phase 3 — DROP legacy spatial columns from trip_entries
--
-- 前置：須先把所有 entries 的 poi_id 回填完成（100% coverage）。Phase 2 在
-- v2.1.3.0 / v2.1.3.1 完成，91/91 entries 已有 poi_id。
-- 驗證：`node scripts/verify-entry-poi-backfill.js` 必須 exit 0。
--
-- 此 migration 不可逆資料損失 — dropped columns 的資料會消失。rollback SQL
-- 只恢復 schema，不恢復資料（需搭配 Phase 3 前的 backup）。
-- backup 指令：`node scripts/dump-d1.js --remote trip-planner-db --out backups/`
--
-- SQLite 3.35+ / D1 支援原生 ALTER TABLE DROP COLUMN（trip_entries 這四欄
-- 無 index / trigger / view，DROP 可直接成功）。
--
-- Drop order：一次一欄（DROP 不接受多欄語法）。

ALTER TABLE trip_entries DROP COLUMN location;
ALTER TABLE trip_entries DROP COLUMN maps;
ALTER TABLE trip_entries DROP COLUMN mapcode;
ALTER TABLE trip_entries DROP COLUMN google_rating;
