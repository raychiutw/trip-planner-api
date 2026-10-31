-- Migration 0048: trip_requests.mode rip-out — Phase 1 (nullable + drop CHECK)
--
-- 拆 NOT NULL + CHECK constraint，讓 code 可以 INSERT 不含 mode column。
-- Phase 2 (follow-up PR) 在 soak ≥ 24 hr 後 DROP COLUMN。
--
-- 安全性：trip_requests 無 children FK → standard swap idiom 即可，不需 0047
-- 的 backup-restore pattern。
--
-- Pre-flight runbook 見 PR description。

-- 若上次 phase 1 中途 fail，*_new 表可能殘留，先清。
DROP TABLE IF EXISTS trip_requests_new;

-- New schema: mode TEXT (no NOT NULL, no CHECK)；其他完全照 0023 + 0046 的 final shape。
CREATE TABLE trip_requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  mode TEXT,                                -- ⚠️ vestigial: phase 2 將 DROP COLUMN
  message TEXT NOT NULL,
  submitted_by TEXT,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'processing', 'completed', 'failed')),
  actions_taken TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT NULL,
  processed_by TEXT DEFAULT NULL CHECK(processed_by IN ('api', 'job') OR processed_by IS NULL)
);

INSERT INTO trip_requests_new (id, trip_id, mode, message, submitted_by, reply, status, actions_taken, created_at, updated_at, processed_by)
SELECT id, trip_id, mode, message, submitted_by, reply, status, actions_taken, created_at, updated_at, processed_by
FROM trip_requests;

DROP TABLE trip_requests;
ALTER TABLE trip_requests_new RENAME TO trip_requests;

-- Recreate indexes (與 0023 一致)
CREATE INDEX idx_trip_requests_trip_id ON trip_requests(trip_id);
CREATE INDEX idx_trip_requests_status ON trip_requests(status);
CREATE INDEX idx_trip_requests_trip_status ON trip_requests(trip_id, status);
CREATE INDEX idx_trip_requests_stale ON trip_requests(status, updated_at);
