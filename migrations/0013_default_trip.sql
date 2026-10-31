-- Add is_default flag to trips table
ALTER TABLE trips ADD COLUMN is_default INTEGER DEFAULT 0;
UPDATE trips SET is_default = 1 WHERE id = 'okinawa-trip-2026-Ray';
