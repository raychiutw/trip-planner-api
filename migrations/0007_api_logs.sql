-- API 錯誤日誌表
CREATE TABLE IF NOT EXISTS api_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  error      TEXT,
  duration   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);
