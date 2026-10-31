-- Step 1: 建新表
CREATE TABLE requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('trip-edit', 'trip-plan')),
  message TEXT NOT NULL,
  submitted_by TEXT,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'received', 'processing', 'completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_by TEXT DEFAULT NULL
);

-- Step 2: 遷移資料
INSERT INTO requests_new (id, trip_id, mode, message, submitted_by, reply, status, created_at, processed_by)
SELECT id, trip_id, mode,
  CASE
    WHEN title IS NOT NULL AND body IS NOT NULL THEN title || char(10) || body
    WHEN title IS NOT NULL THEN title
    WHEN body IS NOT NULL THEN body
    ELSE ''
  END,
  submitted_by, reply,
  CASE WHEN status = 'closed' THEN 'completed' ELSE status END,
  created_at, processed_by
FROM requests;

-- Step 3: 替換
DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;

-- Step 4: 重建索引
CREATE INDEX idx_requests_trip_id ON requests(trip_id);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_trip_status ON requests(trip_id, status);
