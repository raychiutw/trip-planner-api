-- error_reports — 使用者錯誤回報
CREATE TABLE IF NOT EXISTS error_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id       TEXT NOT NULL,
  url           TEXT,
  error_code    TEXT,
  error_message TEXT,
  user_agent    TEXT,
  context       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_reports_trip ON error_reports(trip_id);
CREATE INDEX IF NOT EXISTS idx_error_reports_created ON error_reports(created_at);
