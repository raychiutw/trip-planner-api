-- C1: Prevent duplicate POI master records from concurrent findOrCreatePoi
CREATE UNIQUE INDEX IF NOT EXISTS idx_pois_name_type ON pois(name, type);

-- C2: Prevent duplicate permission grants from concurrent requests
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_email_trip ON trip_permissions(email, trip_id);
