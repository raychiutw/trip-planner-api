-- Migration 0044: Extend trip_invitations.role CHECK to allow 'viewer'.
--
-- Why: v2.18.0 introduces 3-tier role(owner / member / viewer)。trip_invitations
-- 是「user 不存在 → 寄邀請信」的暫存記錄,接受後 INSERT 進 trip_permissions。
-- Inviter 在 CollabPage 可選擇邀請對方為 member 或 viewer,所以 role CHECK 也要放寬。
--
-- 對齊 0043 trip_permissions:同樣 4 種值('owner', 'admin', 'member', 'viewer'),
-- 但實務上 invitation 只會用 'member' / 'viewer'(owner 不可邀請,admin 是系統角色)。
-- CHECK 統一寫 4 種讓 schema 對齊;application 層在 POST /permissions 內做 narrower
-- validation('owner'/'admin' reject)。
--
-- SQLite 不支援 ALTER TABLE DROP CONSTRAINT,recreate table swap。

PRAGMA foreign_keys = OFF;

CREATE TABLE trip_invitations_new (
  token_hash    TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  accepted_at   TEXT,
  accepted_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO trip_invitations_new (
  token_hash, trip_id, invited_email, role, invited_by,
  created_at, expires_at, accepted_at, accepted_by
)
SELECT token_hash, trip_id, invited_email, role, invited_by,
       created_at, expires_at, accepted_at, accepted_by
FROM trip_invitations;

DROP TABLE trip_invitations;
ALTER TABLE trip_invitations_new RENAME TO trip_invitations;

-- Rebuild indexes(對齊 0041 schema)
CREATE INDEX idx_invitations_email ON trip_invitations(invited_email);
CREATE INDEX idx_invitations_trip ON trip_invitations(trip_id);
CREATE INDEX idx_invitations_pending ON trip_invitations(trip_id, accepted_at) WHERE accepted_at IS NULL;
CREATE UNIQUE INDEX idx_invitations_unique_pending
  ON trip_invitations(trip_id, invited_email)
  WHERE accepted_at IS NULL;

PRAGMA foreign_keys = ON;
