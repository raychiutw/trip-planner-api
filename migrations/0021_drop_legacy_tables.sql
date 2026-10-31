-- Drop legacy V1 tables replaced by POI Schema V2
-- hotels / restaurants / shopping → pois + trip_pois
-- trip_docs → trip_docs_v2 + trip_doc_entries
-- Pre-check confirmed: trip_docs (39 rows) fully migrated to trip_docs_v2 (39 rows)

DROP TABLE IF EXISTS hotels;
DROP TABLE IF EXISTS restaurants;
DROP TABLE IF EXISTS shopping;
DROP TABLE IF EXISTS trip_docs;
