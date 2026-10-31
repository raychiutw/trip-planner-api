-- Migration 0032: users + auth_identities — V2-P1 identity core
--
-- Provider-agnostic schema (per docs/v2-oauth-server-plan.md V2-P1 spec)。
-- 預留 Apple / LINE / local password / Google 等多 provider，每 user 多 identity。
--
-- ## users
--
-- - id: uuid string (32 char) — generate at app layer, not autoincrement, 因
--   分散式 ID 預留（V2-P4 OAuth Server 階段 federated user 可帶外部 ID）
-- - email: 主 email，UNIQUE — 用作 display + recovery contact
-- - email_verified_at: nullable，verified flow 才填（V2-P2 spec）
-- - created_at / updated_at: 對齊既有 table convention
-- - status: active / suspended — admin 後續可 ban
--
-- ## auth_identities
--
-- - 一個 user 可有多個 identities（Apple + LINE + email/password）
-- - provider: 'google' / 'apple' / 'line' / 'local' / etc.
-- - provider_user_id: 該 provider 給的 unique ID (Google sub / Apple sub / etc.)
-- - UNIQUE (provider, provider_user_id) — 同 provider 同 ID 只 link 一個 user
-- - password_hash / password_algo: 只 'local' provider 用（argon2id hash）
-- - last_used_at: track 最近用哪個 identity 登入
--
-- ## Backfill 策略（V2-P1 後）
--
-- 既有 saved_pois.email / trip_permissions.email / trip_ideas.added_by 等
-- email column → 在 V2-P1 migration 後跑 backfill script 建 users row +
-- update FK to user_id。本 migration 不改既有 table（避免 breaking change）。

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,           -- uuid (32 char hex)
  email              TEXT NOT NULL UNIQUE,
  email_verified_at  TEXT,                       -- ISO datetime, NULL = unverified
  display_name       TEXT,
  avatar_url         TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE auth_identities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,               -- 'google' | 'apple' | 'line' | 'local' | future
  provider_user_id  TEXT NOT NULL,               -- google sub / apple sub / line userId / email for local
  password_hash     TEXT,                        -- only for provider='local'
  password_algo     TEXT,                        -- 'argon2id' (V2-P2 spec)
  last_used_at      TEXT,                        -- ISO datetime, updated on each login
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX idx_auth_identities_provider ON auth_identities(provider);
