-- Migration 0034: client_apps — V2-P4 OAuth Server client registry
--
-- V2-P4 階段 tripline 開始當 Authorization Server（不只 OAuth Client to Google）。
-- 外部 client app 要走 tripline 的 /oauth/authorize + /oauth/token flow，需要先
-- register 在 client_apps 表，配上 client_id + client_secret + redirect_uris
-- whitelist。
--
-- 對應 docs/v2-oauth-server-plan.md V2-P4 spec：
--   - /oauth/authorize（PKCE + consent screen）
--   - /oauth/token（authorization_code / refresh_token grants）
--   - /.well-known/jwks.json + key rotation
--
-- ## 設計取捨
--
-- - **client_id format**：app-style stable identifier, free-form text，不是 UUID
--   方便 ops human-readable（例：'tripline-mobile-ios' / 'partner-airbnb-poi'）
-- - **client_secret_hash**：argon2id / pbkdf2 hash 不存明文（reuse password module）
-- - **redirect_uris**：JSON array of strings（SQLite 沒 array type，用 TEXT JSON）
-- - **client_type**：'public' (no secret, PKCE required) / 'confidential' (server-side, secret + client_credentials)
-- - **allowed_scopes**：JSON array (e.g. ["openid","profile","email","trips:read"])
-- - **owner_user_id**：誰建這個 client（developer dashboard 顯示用）
-- - **status**：'active' / 'suspended' / 'pending_review' (新 client 要 ops 審核)
--
-- ## Pending V2-P4 next slices
--
-- - /oauth/authorize 接 client_id lookup
-- - /oauth/token client_secret verify (constant-time)
-- - Developer dashboard: register client + view client_id
-- - Audit log on client_app create / suspend

CREATE TABLE client_apps (
  client_id            TEXT PRIMARY KEY,             -- e.g. 'partner-xyz'
  client_secret_hash   TEXT,                          -- pbkdf2$...，public client 為 NULL
  client_type          TEXT NOT NULL CHECK (client_type IN ('public', 'confidential')),
  app_name             TEXT NOT NULL,                 -- consent screen 顯示
  app_description      TEXT,
  app_logo_url         TEXT,
  homepage_url         TEXT,
  redirect_uris        TEXT NOT NULL,                 -- JSON array of strings
  allowed_scopes       TEXT NOT NULL,                 -- JSON array, default '["openid","profile","email"]'
  owner_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending_review'
                         CHECK (status IN ('active', 'suspended', 'pending_review')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_client_apps_owner_user_id ON client_apps(owner_user_id);
CREATE INDEX idx_client_apps_status ON client_apps(status);
