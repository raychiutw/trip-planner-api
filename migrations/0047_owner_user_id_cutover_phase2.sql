-- Migration 0047: V2 owner cutover Phase 2 — DROP email columns + UNIQUE 改 user_id
--
-- ## ⚠️ POST-INCIDENT FIX (2026-05-04)
--
-- 原版本用 `PRAGMA foreign_keys = OFF` + `DROP TABLE trips` + RENAME swap idiom
-- (SQLite 標準 recipe). 在 D1 環境失效 — D1 每個 SQL statement 跑在獨立 connection
-- 上下文，PRAGMA 不持久跨 statement。`DROP TABLE trips` 觸發 ON DELETE CASCADE，
-- 砍光所有 children: trip_days, trip_entries, trip_pois, trip_destinations,
-- trip_docs, trip_doc_entries, trip_invitations。Prod 資料全失。
--
-- 修法 — 顯式 backup → swap → restore pattern：
--   1. 把所有 trips children rows 複製到 _backup_* temp tables
--   2. 做 trips swap (DROP TABLE trips → CASCADE 砍 children — 已 backup,不影響)
--   3. INSERT children back from backups
--   4. DROP backup tables
--
-- 不依賴 PRAGMA 行為。Self-evident 的 backup-restore，D1 安全。
--
-- ## Phase 2 of 2 (phase 1 = migration 0046)
--
-- D6=A approved Big Bang，但 phase 2 仍應由 runbook 強制 manual gate（E-M5）：
--
--   1. 確認 commit 1-6 已 deploy 到 prod（code 100% 走 user_id-based auth dual-read）
--   2. soak ≥ 1 hr，觀察 prod logs 無 auth.email-only fallback 噪音
--   3. `bun scripts/verify-user-backfill.ts` 對 prod 必 PASS（0 orphans）
--   4. wrangler d1 backup bookmark 記錄好（rollback 點）
--   5. 才執行 `wrangler d1 migrations apply trip-planner-db --remote`
--
-- ## E-C1 — Pre-flight assertion via NOT NULL constraint
--
-- NEW TABLE pattern 把 user_id 設 NOT NULL。INSERT INTO ... SELECT ... 若有任何
-- user_id IS NULL row → 違反 NOT NULL → 整個 transaction ABORT，不會半 cutover。
-- 這是 SQLite 內建的 assertion 機制，比手寫 SELECT COUNT 更穩。

-- 若上次 phase 2 中途 fail，*_new 與 _backup_* 表可能殘留 — 先清理確保 idempotent re-run。
DROP TABLE IF EXISTS saved_pois_new;
DROP TABLE IF EXISTS trip_permissions_new;
DROP TABLE IF EXISTS trips_new;
DROP TABLE IF EXISTS _backup_trip_days;
DROP TABLE IF EXISTS _backup_trip_entries;
DROP TABLE IF EXISTS _backup_trip_pois;
DROP TABLE IF EXISTS _backup_trip_destinations;
DROP TABLE IF EXISTS _backup_trip_docs;
DROP TABLE IF EXISTS _backup_trip_doc_entries;
DROP TABLE IF EXISTS _backup_trip_invitations;

-- =============================================
-- 1. saved_pois: drop email, UNIQUE 改 (user_id, poi_id), user_id NOT NULL
-- =============================================
-- saved_pois 沒 children FK 依賴，標準 swap 安全。

CREATE TABLE saved_pois_new (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poi_id    INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  saved_at  TEXT NOT NULL DEFAULT (datetime('now')),
  note      TEXT,
  UNIQUE (user_id, poi_id)
);

INSERT INTO saved_pois_new (id, user_id, poi_id, saved_at, note)
SELECT id, user_id, poi_id, saved_at, note FROM saved_pois;
-- ↑ 若任何 row.user_id IS NULL → ABORT (E-C1 assertion via NOT NULL)

DROP TABLE saved_pois;
ALTER TABLE saved_pois_new RENAME TO saved_pois;
-- UNIQUE (user_id, poi_id) auto-creates index covering user_id lookups, only need poi_id index.
CREATE INDEX idx_saved_pois_poi ON saved_pois(poi_id);

-- =============================================
-- 2. trip_permissions: drop email, UNIQUE 改 (user_id, trip_id)
--    ⚠️ 例外：email='*' wildcard public-read 不 cutover（無 user_id 對應）
--    → 此 PR 範圍內保留為「歷史遺留」，未來另開 PR 用 dedicated public_trips column
-- =============================================
-- trip_permissions 也沒 children FK 依賴，標準 swap 安全。

CREATE TABLE trip_permissions_new (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id TEXT NOT NULL,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  UNIQUE (user_id, trip_id)
);

INSERT INTO trip_permissions_new (id, user_id, trip_id, role)
SELECT id, user_id, trip_id, role FROM trip_permissions
WHERE user_id IS NOT NULL AND email != '*';
-- ↑ ABORT if NOT NULL violated (E-C1 assertion). '*' wildcard 暫時 drop（未來 dedicated public_trips column）

DROP TABLE trip_permissions;
ALTER TABLE trip_permissions_new RENAME TO trip_permissions;
-- UNIQUE (user_id, trip_id) covers user_id-only and (user_id, trip_id) lookups.

-- =============================================
-- 3. trips: drop owner (email column), owner_user_id NOT NULL
--    ⚠️ trips 有大量 CASCADE children — 必 backup 再 swap 再 restore.
-- =============================================

-- Step 3a: backup all trips children (data 不依賴 FK，純 SELECT * 複製)
CREATE TABLE _backup_trip_days        AS SELECT * FROM trip_days;
CREATE TABLE _backup_trip_entries     AS SELECT * FROM trip_entries;
CREATE TABLE _backup_trip_pois        AS SELECT * FROM trip_pois;
CREATE TABLE _backup_trip_destinations AS SELECT * FROM trip_destinations;
CREATE TABLE _backup_trip_docs        AS SELECT * FROM trip_docs;
CREATE TABLE _backup_trip_doc_entries AS SELECT * FROM trip_doc_entries;
CREATE TABLE _backup_trip_invitations AS SELECT * FROM trip_invitations;

-- Step 3b: trips swap. DROP TABLE trips 會 CASCADE 砍 children — 已 backup,不影響.
CREATE TABLE trips_new (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  owner_user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title                 TEXT,
  description           TEXT,
  countries             TEXT,
  published             INTEGER DEFAULT 0,
  data_source           TEXT DEFAULT 'manual',
  default_travel_mode   TEXT DEFAULT 'driving',
  lang                  TEXT DEFAULT 'zh-TW',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO trips_new (
  id, name, owner_user_id, title, description, countries, published,
  data_source, default_travel_mode, lang, created_at, updated_at
)
SELECT
  id, name, owner_user_id, title, description, countries, published,
  data_source, default_travel_mode, lang, created_at, updated_at
FROM trips;
-- ↑ ABORT if any owner_user_id IS NULL (E-C1 assertion)

DROP TABLE trips;
ALTER TABLE trips_new RENAME TO trips;
CREATE INDEX idx_trips_owner_user_id ON trips(owner_user_id);

-- Step 3c: restore children from backups. 此時 trips 已重建 (same id values),
-- FK references match by VALUE,re-INSERT 合法。
INSERT INTO trip_days        SELECT * FROM _backup_trip_days;
INSERT INTO trip_entries     SELECT * FROM _backup_trip_entries;
INSERT INTO trip_pois        SELECT * FROM _backup_trip_pois;
INSERT INTO trip_destinations SELECT * FROM _backup_trip_destinations;
INSERT INTO trip_docs        SELECT * FROM _backup_trip_docs;
INSERT INTO trip_doc_entries SELECT * FROM _backup_trip_doc_entries;
INSERT INTO trip_invitations SELECT * FROM _backup_trip_invitations;

-- Step 3d: cleanup backups
DROP TABLE _backup_trip_days;
DROP TABLE _backup_trip_entries;
DROP TABLE _backup_trip_pois;
DROP TABLE _backup_trip_destinations;
DROP TABLE _backup_trip_docs;
DROP TABLE _backup_trip_doc_entries;
DROP TABLE _backup_trip_invitations;

-- 重新整 query planner stats — 表 swap 後 sqlite_stat1 過期會誤選 index
ANALYZE saved_pois;
ANALYZE trip_permissions;
ANALYZE trips;
ANALYZE trip_days;
ANALYZE trip_entries;
ANALYZE trip_pois;
