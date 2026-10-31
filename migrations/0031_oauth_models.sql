-- Migration 0031: oauth_models — Panva oidc-provider D1 adapter storage
--
-- V2-P1 schema (per docs/v2-oauth-server-plan.md)。Generic key-value store for
-- oidc-provider 的所有 model types：Session / AuthorizationCode / AccessToken /
-- RefreshToken / Grant / Interaction / DeviceCode / RegistrationAccessToken / etc.
--
-- 設計取捨：
--   - 用 single table generic store 而非 per-model table — Panva oidc-provider
--     的 Adapter interface 對所有 model 用同一套 API（upsert/find/destroy 等），
--     且不同 model 的 fields 變動大，generic JSON payload 較 maintainable
--   - PRIMARY KEY (name, id) — name 是 model class name (e.g. 'Session')，
--     id 是 model 的 jti / code / token 字串。複合 key 確保跨 model 不撞
--   - expires_at INTEGER unix ms — 比 SQLite datetime() 字串好做數字比較；
--     find() 內 inline 過期檢查（lazy delete on read）
--   - JSON payload 用 SQLite json_extract() 索引特定欄位（grantId / uid）
--   - **不用 FK to users** — oauth_models 生命週期短（minutes-hours），
--     user 被刪時 access_token 過期即可，不需 cascade
--
-- 索引：
--   - idx_oauth_models_expires：cron job DELETE WHERE expires_at < now() 用
--   - idx_oauth_models_grant：revokeByGrantId() 用 json_extract index

CREATE TABLE oauth_models (
  name        TEXT NOT NULL,
  id          TEXT NOT NULL,
  payload     TEXT NOT NULL,        -- JSON serialized AdapterPayload
  expires_at  INTEGER NOT NULL,     -- unix ms
  PRIMARY KEY (name, id)
);

CREATE INDEX idx_oauth_models_expires ON oauth_models(expires_at);
CREATE INDEX idx_oauth_models_grant ON oauth_models(json_extract(payload, '$.grantId'));
CREATE INDEX idx_oauth_models_uid ON oauth_models(json_extract(payload, '$.uid'));
