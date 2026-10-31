-- hotels table no longer exists in production (dropped during POI Schema migration)
-- Original: ALTER TABLE hotels ADD COLUMN location_json TEXT
-- Now a no-op to allow migration chain to proceed to 0021 (drop legacy tables)
SELECT 1;
