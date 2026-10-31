-- Owner-controlled archive is trip-wide: every collaborator sees the same state.
-- Existing trips remain active.
ALTER TABLE trips ADD COLUMN archived_at TEXT DEFAULT NULL;
