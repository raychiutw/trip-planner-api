-- Migration 0082: mobile OAuth client + account notification preferences.
--
-- Flutter client can enable OAuth PKCE once an active public client exists.
-- Notification preferences are per-user, default enabled, and currently cover
-- the three product notification groups surfaced in the account settings UI.

CREATE TABLE IF NOT EXISTS account_notification_preferences (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trip_updates  INTEGER NOT NULL DEFAULT 1 CHECK (trip_updates IN (0, 1)),
  invitations   INTEGER NOT NULL DEFAULT 1 CHECK (invitations IN (0, 1)),
  system        INTEGER NOT NULL DEFAULT 1 CHECK (system IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO client_apps (
  client_id,
  client_secret_hash,
  client_type,
  app_name,
  app_description,
  redirect_uris,
  allowed_scopes,
  status
)
VALUES (
  'tripline-mobile',
  NULL,
  'public',
  'Tripline Mobile',
  'Official Tripline Flutter mobile app',
  '["http://127.0.0.1:8765"]',
  '["openid","profile","email","offline_access"]',
  'active'
)
ON CONFLICT(client_id) DO UPDATE SET
  client_secret_hash = NULL,
  client_type = 'public',
  app_name = excluded.app_name,
  app_description = excluded.app_description,
  redirect_uris = excluded.redirect_uris,
  allowed_scopes = excluded.allowed_scopes,
  status = 'active',
  updated_at = datetime('now');
