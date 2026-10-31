-- Migration 0035: rate_limit_buckets — V2-P6 brute force defence
--
-- Per-IP + per-key counters with sliding window + lockout。Caller (e.g.
-- functions/api/oauth/login.ts) 透過 functions/api/_rate_limit.ts 的
-- checkRateLimit() 操作。
--
-- ## Schema
--
-- bucket_key 範例:
--   'login:1.2.3.4'                     — login attempts from IP
--   'login:user@example.com'            — login attempts for email (anti-credential-stuffing)
--   'signup:1.2.3.4'                    — signup spam
--   'forgot-password:user@example.com'  — reset abuse
--   'oauth-token:partner-x'             — token endpoint per-client
--
-- ## Algorithm
--
-- Sliding window with lockout:
--   1. checkRateLimit(key, maxAttempts=5, windowMs=15min, lockoutMs=30min):
--      - row exists 且 locked_until > now → 429 Retry-After: locked_until - now
--      - row exists 且 window_start + windowMs < now → reset (window expired)
--      - count++ atomically
--      - 若 count > maxAttempts → set locked_until = now + lockoutMs, return locked
--      - else: return ok
--
-- ## Cleanup
--
-- V2-P6 cron job 每小時跑 DELETE WHERE locked_until IS NULL AND
-- window_start + 1h < now (清過期 unlocked rows 避無限長)。

CREATE TABLE rate_limit_buckets (
  bucket_key      TEXT PRIMARY KEY,                    -- e.g. 'login:1.2.3.4'
  count           INTEGER NOT NULL DEFAULT 0,
  window_start    INTEGER NOT NULL,                    -- unix ms
  locked_until    INTEGER,                              -- unix ms, NULL = not locked
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rate_limit_locked ON rate_limit_buckets(locked_until);
CREATE INDEX idx_rate_limit_window ON rate_limit_buckets(window_start);
