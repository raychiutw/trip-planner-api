-- Migration 0069 — v2.33.60 round 14: trip_health_reports FK 補齊
--
-- Round 14 security audit finding: trip_health_reports.user_id 跟 request_id 是
-- 裸 column 無 FK。問題：
--   1. user 刪除 (V2-P6 規劃) 後 findings_json 含 PII orphan 保留 → GDPR
--      right-to-erasure 違反
--   2. trip_requests 經 trips ON DELETE CASCADE 刪除後 request_id 變 dangling
--
-- D1 不支援 ALTER TABLE ADD CONSTRAINT，必須 swap pattern：
--   1. CREATE 新表 trip_health_reports_new with FK
--   2. INSERT SELECT 既有 row (LEFT JOIN guard 對應 row 存在)
--   3. DROP 舊 → RENAME 新
--   4. CREATE INDEX (兩個)
--
-- Deploy order: prod backend 不會在 migration 前後讀到不同 schema (column 一樣)，
-- safe to apply anytime。
-- Rollback: 0069_revert_trip_health_reports_fk.sql (拔 FK 回原 schema)。

CREATE TABLE trip_health_reports_new (
  trip_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  request_id INTEGER REFERENCES trip_requests(id) ON DELETE SET NULL,
  findings_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

-- 把現有 row 搬過去，但只搬 user_id 仍存在的 (FK 強制 NOT NULL)。
-- 應該全部 row 都符合 — V2-P6 未上線無 user delete 動作。
INSERT INTO trip_health_reports_new (
  trip_id, user_id, status, request_id, findings_json, error_message, created_at, completed_at
)
SELECT
  h.trip_id, h.user_id, h.status,
  CASE WHEN tr.id IS NULL THEN NULL ELSE h.request_id END AS request_id,
  h.findings_json, h.error_message, h.created_at, h.completed_at
FROM trip_health_reports h
INNER JOIN users u ON u.id = h.user_id
LEFT JOIN trip_requests tr ON tr.id = h.request_id;

DROP TABLE trip_health_reports;
ALTER TABLE trip_health_reports_new RENAME TO trip_health_reports;

CREATE INDEX idx_trip_health_reports_request_id ON trip_health_reports(request_id);
CREATE INDEX idx_trip_health_reports_status ON trip_health_reports(status);
