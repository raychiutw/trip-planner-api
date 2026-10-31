-- 0023: Request 狀態機更新
-- - 移除 received 狀態
-- - 新增 failed 狀態
-- - 新增 updated_at 欄位（卡住偵測用）
-- - processed_by 加 CHECK constraint

CREATE TABLE trip_requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('trip-edit', 'trip-plan')),
  message TEXT NOT NULL,
  submitted_by TEXT,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'processing', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT NULL,
  processed_by TEXT DEFAULT NULL CHECK(processed_by IN ('api', 'job') OR processed_by IS NULL)
);

INSERT INTO trip_requests_new (id, trip_id, mode, message, submitted_by, reply, status, created_at, processed_by)
SELECT id, trip_id, mode, message, submitted_by, reply,
  CASE WHEN status = 'received' THEN 'open' ELSE status END,
  created_at,
  CASE
    WHEN processed_by = 'agent' THEN 'api'
    WHEN processed_by = 'scheduler' THEN 'job'
    WHEN processed_by IN ('api', 'job') THEN processed_by
    ELSE NULL
  END
FROM trip_requests;

DROP TABLE trip_requests;
ALTER TABLE trip_requests_new RENAME TO trip_requests;

CREATE INDEX idx_trip_requests_trip_id ON trip_requests(trip_id);
CREATE INDEX idx_trip_requests_status ON trip_requests(status);
CREATE INDEX idx_trip_requests_trip_status ON trip_requests(trip_id, status);
CREATE INDEX idx_trip_requests_stale ON trip_requests(status, updated_at);
