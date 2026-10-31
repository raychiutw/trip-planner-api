-- Migration 0043: Extend trip_permissions.role CHECK to allow 'viewer'.
--
-- Why: v2.18.0 introduces 3-tier role model (owner / member / viewer):
--   - owner:   trip 創建者,單一,不可改 + 不可移除
--   - member:  共編成員,可檢視 + 編輯
--   - viewer:  檢視成員,只可檢視,不可編輯(read-only collaborator)
--
-- 既有 'admin' role 保留(系統管理員),不影響。
--
-- SQLite 不支援 ALTER TABLE DROP CONSTRAINT,必須 recreate 整張表 swap。
-- 對齊 0039 的 pattern。

PRAGMA foreign_keys = OFF;

CREATE TABLE trip_permissions_new (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  email   TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(email, trip_id)
);

INSERT INTO trip_permissions_new (id, email, trip_id, role, user_id)
SELECT id, email, trip_id, role, user_id FROM trip_permissions;

DROP TABLE trip_permissions;
ALTER TABLE trip_permissions_new RENAME TO trip_permissions;

CREATE INDEX IF NOT EXISTS idx_permissions_email ON trip_permissions(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_email_trip ON trip_permissions(email, trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_permissions_user_id ON trip_permissions(user_id);

PRAGMA foreign_keys = ON;
