-- Add missing composite indexes
CREATE INDEX IF NOT EXISTS idx_audit_trip_time ON audit_log(trip_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_trip_status ON requests(trip_id, status);
CREATE INDEX IF NOT EXISTS idx_permissions_trip ON permissions(trip_id);

-- Add api_logs cleanup: add index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);
