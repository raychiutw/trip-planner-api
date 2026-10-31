-- Migration 0040: trip_invitations — V2 共編分享信邀請 token
--
-- 為什麼新表不重用 oauth_models（D1Adapter）：
--   1. 需要 query by email + by trip_id（CollabSheet pending list / 重寄查重）
--   2. invitation 有 lifecycle 欄位（accepted_at / accepted_by），不適合 JSON blob
--   3. oauth_models 語意是 OAuth token store，混入 invitation 不乾淨
--
-- 為什麼 token_hash 是 PK 不存 raw token：
--   - 跟 _session.ts cookie / forgot-password.ts pattern 一致
--   - DB dump 不能直接反查 token，只能用 HMAC(SESSION_SECRET, raw) 比對
--   - raw token 只活在 email 內容 + URL query string
--
-- 為什麼 role CHECK 只允許 'member'：
--   - V2 共編語意 = member（owner 不可被邀請，admin 是 system role）
--   - 未來若要邀請 'admin' role 再 ALTER（recreate table swap）
--
-- 為什麼 expires_at 是 TEXT 而非 INTEGER timestamp：
--   - 跟其他 V2 schema（auth_audit_log / session_devices）一致用 ISO TEXT
--   - SQLite datetime 比較對 ISO 字串有效（'2026-05-04 ...' < '2026-05-05 ...'）
--
-- ## Lifecycle
--
-- 1. POST /api/permissions { email, tripId } → 若 email 未註冊：
--    INSERT trip_invitations (token_hash, trip_id, invited_email, invited_by, expires_at = now + 7d)
--    寄 email 含 raw token
-- 2. 點 link → /invite?token=xxx → GET /api/invitations?token=xxx → 顯示 trip preview
-- 3. 登入/註冊後 → POST /api/invitations/accept { token } → user.email 必須 match
--    UPDATE accepted_at + accepted_by + INSERT trip_permissions
-- 4. 過期 / 已接受：lazy expire on read。
--    **TODO(post-V2)**：cleanup cron 砍 30 天前 expired/accepted rows — 未在此 PR scope，
--    對齊 docs/v2-launch-pending.md A5（auth_audit_log + session_devices 也要 cleanup
--    cron），考慮一次處理。

CREATE TABLE trip_invitations (
  token_hash    TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member')),
  invited_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- created_at 用 datetime('now') 跟 0036/0037 一致格式；accepted_at 由 application
  -- 寫 ISO 8601 (Date.toISOString)，兩種 format 都可比較（< datetime('now')）但 row
  -- 內 format 略有差異 — 接受此小不一致避免改 application code path。
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  accepted_at   TEXT,
  accepted_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_invitations_email ON trip_invitations(invited_email);
CREATE INDEX idx_invitations_trip ON trip_invitations(trip_id);
CREATE INDEX idx_invitations_pending ON trip_invitations(trip_id, accepted_at) WHERE accepted_at IS NULL;
