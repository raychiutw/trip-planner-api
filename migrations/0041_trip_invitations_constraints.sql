-- Migration 0041: trip_invitations 約束強化（review findings）
--
-- 修兩個 0040 schema 缺漏：
--   1. 加 UNIQUE(trip_id, invited_email) WHERE accepted_at IS NULL —
--      原本 0040 沒 UNIQUE，application code permissions.ts:228 的 UNIQUE catch 是
--      dead code，且同 (trip, email) 可累積無限多 pending invitation（DB bloat +
--      audit-log noise + ambiguous CollabSheet pending UI）。partial unique index
--      只約束 pending（accepted_at IS NULL），允許歷史 accepted invitation 共存
--      （不衝突且需保留 audit trail）。
--
--   2. invited_by ON DELETE CASCADE → SET NULL —
--      原本刪邀請者 user 會 cascade 砍光該 user 寄出的所有 invitation（含已接受），
--      audit trail 全消。改成 SET NULL（跟 accepted_by 對稱），刪 user 後保留
--      invitation 紀錄但 invited_by 變 NULL（顯示「已刪除使用者」）。
--      代價：invited_by 必須 nullable。
--
-- SQLite 不支援 ALTER TABLE 改 FK／加 partial UNIQUE INDEX 在現有表，
-- 必須 recreate table swap：
--   1. 暫關 FK
--   2. CREATE TABLE _new with new schema
--   3. INSERT SELECT 搬資料
--   4. DROP old + RENAME new
--   5. 重建 indexes
--   6. 開回 FK

PRAGMA foreign_keys = OFF;

CREATE TABLE trip_invitations_new (
  token_hash    TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member')),
  -- 改 SET NULL 並 nullable，保留歷史 audit trail 即使邀請者 user 被刪
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

-- 重建 indexes（含原有 + 新 partial unique）
CREATE INDEX idx_invitations_email ON trip_invitations(invited_email);
CREATE INDEX idx_invitations_trip ON trip_invitations(trip_id);
CREATE INDEX idx_invitations_pending ON trip_invitations(trip_id, accepted_at) WHERE accepted_at IS NULL;
-- partial unique index：同一 trip 同一 invited_email 同時只能有 1 筆 pending invitation
-- 已 accepted（accepted_at IS NOT NULL）的歷史紀錄不受約束，可累積保留 audit trail
CREATE UNIQUE INDEX idx_invitations_unique_pending
  ON trip_invitations(trip_id, invited_email)
  WHERE accepted_at IS NULL;

PRAGMA foreign_keys = ON;
