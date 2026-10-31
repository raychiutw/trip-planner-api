-- Migration 0036: auth_audit_log — V2-P6 audit log expansion
--
-- 用於 V2 OAuth Server / 帳密 / session 事件審計。**獨立於 audit_log**（後者
-- 記 trip CRUD），因為 OAuth event 的 schema shape 不同（沒有 trip_id）。
--
-- ## Events covered
--
-- | event_type              | user_id | client_id | failure_reason 例 |
-- |-------------------------|---------|-----------|------------------|
-- | signup                  | ✓ 成功時 | —         | rate_limited / dup_email |
-- | login                   | ✓ 成功時 | —         | wrong_password / unknown_email / rate_limited |
-- | logout                  | ✓       | —         | — |
-- | password_reset_request  | —       | —         | rate_limited |
-- | password_reset_complete | ✓       | —         | invalid_token / token_used |
-- | oauth_authorize         | ✓ 成功時 | ✓        | invalid_redirect / consent_denied |
-- | oauth_consent           | ✓       | ✓        | — |
-- | token_issue             | ✓       | ✓        | invalid_grant / pkce_mismatch / rate_limited |
-- | token_revoke            | ✓       | ✓        | — |
-- | rate_limited            | —       | —         | — (event 本身就是) |
--
-- ## Privacy
--
-- ip_hash 是 SHA-256(ip)。設計目標是「使 audit log 在 DB dump 中不顯示
-- 純 IP，但 attacker 仍可逐個 hash 反查」— 防 casual leak 不防積極攻擊。
-- 真正的隱私靠 D1 access control + R2 cold storage retention policy。
--
-- ## Retention
--
-- 30 天 D1 + Logpush → R2 長期 (per autoplan)。Cleanup 由 V2-P6 cron job
-- DELETE WHERE created_at < datetime('now', '-30 days')。

CREATE TABLE auth_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id        TEXT,                                    -- correlation across multi-step OAuth flow
  event_type      TEXT NOT NULL,                           -- enum (string for forward compat)
  outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  user_id         TEXT,                                    -- NULL when not yet identified
  client_id       TEXT,                                    -- NULL for non-OAuth events
  ip_hash         TEXT NOT NULL,                           -- SHA-256(ip)
  user_agent      TEXT,                                    -- truncated at 200 chars
  failure_reason  TEXT,                                    -- e.g. 'wrong_password'
  metadata        TEXT,                                    -- JSON for event-specific extras
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_auth_audit_user_time ON auth_audit_log(user_id, created_at);
CREATE INDEX idx_auth_audit_client_time ON auth_audit_log(client_id, created_at);
CREATE INDEX idx_auth_audit_event_outcome ON auth_audit_log(event_type, outcome, created_at);
CREATE INDEX idx_auth_audit_time ON auth_audit_log(created_at);
