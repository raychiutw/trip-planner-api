ALTER TABLE requests ADD COLUMN processed_by TEXT DEFAULT NULL;
-- DEPRECATED: No longer set by new requests (webhook/agent mechanism removed).
-- Column retained for historical data. See migration 0006_remove_webhook.sql.
