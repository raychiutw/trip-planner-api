-- Migration 0039: Extend trip_permissions.role CHECK to allow 'owner'.
--
-- Why: PR-CC formalizes owner concept — trip 創建者 = owner（trip.owner），
-- 加入共編 = member。trip_permissions 也要存 owner row（讓 hasPermission /
-- ensureCanManageTripPerms 統一從 perms table 查），但原本 CHECK 只允許
-- 'admin' / 'member'，需要擴充。
--
-- SQLite 不支援 ALTER TABLE DROP CONSTRAINT，必須 recreate 整張表 swap。

PRAGMA foreign_keys = OFF;

CREATE TABLE trip_permissions_new (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  email   TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
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
