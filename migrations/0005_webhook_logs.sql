CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  tunnel_url TEXT,
  status TEXT NOT NULL,        -- 'sent', 'failed', 'no_tunnel'
  http_status INTEGER,         -- webhook 回應的 HTTP status code
  error TEXT,                  -- 錯誤訊息
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);
