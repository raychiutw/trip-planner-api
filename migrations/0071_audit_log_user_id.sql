-- Migration 0071 — v2.33.62 round 14c: audit_log 加 user_id FK
--
-- Round 14 security-auditor LOW: audit_log.changed_by 是 free-form TEXT
-- (email / 'service:client-id' / 'companion:N')。無 FK 無 user_id col → 未來
-- user 刪除 leaves dangling email values，難以 right-to-erasure compliance。
--
-- 設計: 加 `changed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`
-- column。
-- - 新寫入: application code 雙寫 (changed_by email + changed_by_user_id)。
-- - 舊 row: 一次性 backfill via JOIN users.email (best-effort)。
-- - 之後 user 刪除 → ON DELETE SET NULL → user_id 變 null but email 保留 forensic。
--
-- 不 ADD NOT NULL on changed_by_user_id — 'service:*' / 'companion:N' / null
-- 等 non-user actor 沒對應 users.id。
--
-- Note: D1 不支援 ADD COLUMN with REFERENCES (forbid added FK on existing).
-- 用 swap pattern: CREATE audit_log_new with FK → INSERT-SELECT with JOIN
-- backfill → DROP audit_log → RENAME。Index 重建。

-- audit_log 經歷過 0050 加 companion_failure_reason col。swap 時必須對齊現況 schema
-- (包括所有後加 col)。
CREATE TABLE audit_log_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL,
  table_name      TEXT NOT NULL,
  record_id       INTEGER,
  action          TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  changed_by      TEXT,
  changed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  request_id      INTEGER,
  diff_json       TEXT,
  snapshot        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  companion_failure_reason TEXT
);

-- Backfill changed_by_user_id via JOIN users.email。
-- LEFT JOIN — 'service:*' / 'companion:*' / null email 留 changed_by_user_id NULL。
INSERT INTO audit_log_new (
  id, trip_id, table_name, record_id, action, changed_by, changed_by_user_id,
  request_id, diff_json, snapshot, created_at, companion_failure_reason
)
SELECT
  a.id, a.trip_id, a.table_name, a.record_id, a.action, a.changed_by, u.id AS changed_by_user_id,
  a.request_id, a.diff_json, a.snapshot, a.created_at, a.companion_failure_reason
FROM audit_log a
LEFT JOIN users u ON u.email = a.changed_by;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_trip ON audit_log(trip_id);
CREATE INDEX idx_audit_time ON audit_log(created_at);
CREATE INDEX idx_audit_user ON audit_log(changed_by_user_id);
