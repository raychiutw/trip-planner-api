-- 0087: poi_favorites soft-delete 支援（單筆收藏取消/復原 API）
-- 規格：docs/backend-tasks/2026-07-18-poi-favorites-undo-restore-api.md
--
-- 兩件事：
--   (1) 新增 nullable `deleted_at` 欄（soft-delete tombstone）。
--   (2) 唯一性由 table-level `UNIQUE(user_id, poi_id)`（0050:33，全域）改為
--       **partial unique index 只限 active row**（deleted_at IS NULL）。
--
-- 為何 swap idiom（非 ALTER）：SQLite 無法 DROP table-level constraint；`UNIQUE(user_id,poi_id)`
-- 是建表約束、只能重建表移除。poi_favorites 無 children FK 指向它（僅 FK 指向 users/pois 為 parent），
-- 故重建安全、不需 backup-restore children（對比 trips/pois 用 0047 idiom）。
--
-- ⚠️ 部署順序（見 project_d1_migration_phase_split）：本 migration **backward-compatible**（舊 code
-- 不寫 deleted_at → 所有 row 皆 active → partial index 等同原 full unique；舊 GET 不 filter 也只看到
-- active row）。故屬 **additive：先 apply 再 merge**。CI push 命中 migrations/** 會自動套 prod D1，
-- 常搶在 CF Pages 部署前 — 安全，因舊 code 與新 schema 相容。
--
-- Rollback：migrations/rollback/0087_poi_favorites_soft_delete_rollback.sql（回 full unique + 去 deleted_at；
-- 有 soft-deleted+active 同 (user,poi) 時 rollback 會撞 full unique → 需先清 soft-deleted，說明見 rollback 檔）。

-- 1. 新表：無 table-level UNIQUE(user_id,poi_id)、加 deleted_at。其餘欄位/FK/default 與 0050 一致。
CREATE TABLE poi_favorites_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poi_id       INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  favorited_at TEXT NOT NULL DEFAULT (datetime('now')),
  note         TEXT,
  deleted_at   TEXT DEFAULT NULL
);

-- 2. 搬資料：既有 row 全為 active（deleted_at 留 NULL）。顯式帶 id 保留原主鍵
--    （AUTOINCREMENT 表 insert 顯式 id 會把 sqlite_sequence 推到 max，下一筆接續）。
INSERT INTO poi_favorites_new (id, user_id, poi_id, favorited_at, note)
  SELECT id, user_id, poi_id, favorited_at, note FROM poi_favorites;

-- 3. 換表
DROP TABLE poi_favorites;
ALTER TABLE poi_favorites_new RENAME TO poi_favorites;

-- 4. 重建 index：poi_id lookup（非唯一，沿用 0050）+ **partial unique 只限 active**
--    （取代原 table UNIQUE 的隱式 index）。soft-deleted row（deleted_at NOT NULL）不入此 index，
--    故同 (user,poi) 可有多筆 soft-deleted + 至多 1 筆 active。
CREATE INDEX idx_poi_favorites_poi ON poi_favorites(poi_id);
CREATE UNIQUE INDEX idx_poi_favorites_active_user_poi
  ON poi_favorites(user_id, poi_id) WHERE deleted_at IS NULL;

-- 5. 部分索引撈不到、但 restore/清理常用「找某 (user,poi) 的 soft-deleted」→ 補一支輔助 index。
CREATE INDEX idx_poi_favorites_user_poi_deleted
  ON poi_favorites(user_id, poi_id, deleted_at);
