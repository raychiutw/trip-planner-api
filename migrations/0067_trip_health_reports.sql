-- Migration 0067: AI 健檢功能 — trip_health_reports table
--
-- 行程 AI 健檢結果儲存。每個 trip 只保留最新一份（PRIMARY KEY trip_id），
-- re-generate 直接 UPSERT。Findings 以 JSON array 存 findings_json。
--
-- 觸發流程：
-- 1. POST /api/trips/:id/health-check 建/覆寫 trip_health_reports (status='pending')
-- 2. 同時 INSERT trip_requests message='[AI 健檢] ...' (chat trail 同步)
-- 3. api-server processLoop 跑 Claude → PATCH /api/requests/:id reply + completed
-- 4. PATCH hook detect message 開頭 [AI 健檢] → parse reply JSON → UPDATE trip_health_reports
--
-- Reply schema (Claude 必須回傳 JSON array)：
--   [{severity: 'high'|'medium'|'low', title: string, description: string,
--     action_target?: { day?: number, entry_id?: number }}]
--
-- Naming 避開 v2.23.0 既有 TripHealthBanner (POI lifecycle health)，本表是
-- AI 行程建議結果，class prefix 用 tp-ai-health-*。

CREATE TABLE trip_health_reports (
  trip_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  request_id INTEGER,
  findings_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX idx_trip_health_reports_request_id ON trip_health_reports(request_id);
CREATE INDEX idx_trip_health_reports_status ON trip_health_reports(status);
