-- 旅伴請求表
CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id      TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('trip-edit', 'trip-plan')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  submitted_by TEXT,
  reply        TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_requests_trip_id ON requests(trip_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

-- 權限表（email <-> tripId 對應）
CREATE TABLE IF NOT EXISTS permissions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  email   TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  UNIQUE(email, trip_id)
);

CREATE INDEX IF NOT EXISTS idx_permissions_email ON permissions(email);
