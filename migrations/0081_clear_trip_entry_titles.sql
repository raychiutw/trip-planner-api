-- Migration 0081: drop legacy entry titles.
-- Entry display is now canonical primary POI name:
-- trip_entry_pois.sort_order = 1 -> pois.name.

-- Do not rebuild/drop trip_entries: child tables reference it with ON DELETE CASCADE.
-- Dropping/recreating the parent table risks deleting trip_entry_pois/trip_segments rows.
ALTER TABLE trip_entries DROP COLUMN title;
