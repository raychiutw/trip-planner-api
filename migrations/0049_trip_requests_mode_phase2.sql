-- Migration 0049: trip_requests.mode rip-out — Phase 2 (DROP COLUMN)
--
-- Phase 1 (0048) 已把 column 改 nullable + drop CHECK，code 已停止寫 mode。
-- Phase 2 真正 DROP COLUMN，schema 完全乾淨。
--
-- 安全性：trip_requests 無 children FK；standard SQLite swap idiom（非 0047
-- backup-restore pattern）。新 schema 不含 mode column，舊 data 的 mode 值丟棄。
--
-- Pre-flight runbook 見 PR description。

-- 若上次 phase 2 中途 fail，*_new 表可能殘留，先清。
DROP TABLE IF EXISTS trip_requests_new;

-- New schema 不含 mode column；其他完全照 phase 1 final shape。
CREATE TABLE trip_requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  message TEXT NOT NULL,
  submitted_by TEXT,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'processing', 'completed', 'failed')),
  actions_taken TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT NULL,
  processed_by TEXT DEFAULT NULL CHECK(processed_by IN ('api', 'job') OR processed_by IS NULL)
);

INSERT INTO trip_requests_new (id, trip_id, message, submitted_by, reply, status, actions_taken, created_at, updated_at, processed_by)
SELECT id, trip_id, message, submitted_by, reply, status, actions_taken, created_at, updated_at, processed_by
FROM trip_requests;

DROP TABLE trip_requests;
ALTER TABLE trip_requests_new RENAME TO trip_requests;

-- Recreate indexes (與 0023/0048 一致)
CREATE INDEX idx_trip_requests_trip_id ON trip_requests(trip_id);
CREATE INDEX idx_trip_requests_status ON trip_requests(status);
CREATE INDEX idx_trip_requests_trip_status ON trip_requests(trip_id, status);
CREATE INDEX idx_trip_requests_stale ON trip_requests(status, updated_at);
