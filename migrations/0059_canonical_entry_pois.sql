-- Migration 0059: canonical entry POIs cutover
--
-- v2.27 introduced trip_entry_pois as the real model for "one entry -> one or
-- more POIs", but timeline restaurant options still existed in legacy
-- trip_pois(context='timeline') rows and were promoted at read time. This
-- migration makes the data canonical:
--
-- 1. Move per-entry timeline POI overrides into trip_entry_pois.
-- 2. Rewrite affected entry POI lists so trip_pois timeline ordering becomes
--    the canonical sort_order=1..N list, followed by any existing entry POIs
--    not already represented.
-- 3. Delete legacy trip_pois(context='timeline') rows.

ALTER TABLE trip_entry_pois ADD COLUMN description TEXT;
ALTER TABLE trip_entry_pois ADD COLUMN note TEXT;
ALTER TABLE trip_entry_pois ADD COLUMN reservation TEXT;
ALTER TABLE trip_entry_pois ADD COLUMN reservation_url TEXT;

DROP TABLE IF EXISTS _m0059_canonical_entry_pois;

CREATE TABLE _m0059_canonical_entry_pois AS
WITH affected_entries AS (
  SELECT DISTINCT entry_id
  FROM trip_pois
  WHERE context = 'timeline'
    AND entry_id IS NOT NULL
    AND poi_id IS NOT NULL
),
combined AS (
  SELECT
    tp.entry_id,
    tp.poi_id,
    0 AS source_rank,
    COALESCE(tp.sort_order, 0) AS source_order,
    tp.id AS source_id,
    datetime('now') AS added_at,
    datetime('now') AS updated_at,
    tp.description,
    tp.note,
    tp.reservation,
    tp.reservation_url
  FROM trip_pois tp
  WHERE tp.context = 'timeline'
    AND tp.entry_id IS NOT NULL
    AND tp.poi_id IS NOT NULL

  UNION ALL

  SELECT
    tep.entry_id,
    tep.poi_id,
    1 AS source_rank,
    tep.sort_order AS source_order,
    tep.id AS source_id,
    tep.added_at,
    tep.updated_at,
    tep.description,
    tep.note,
    tep.reservation,
    tep.reservation_url
  FROM trip_entry_pois tep
  JOIN affected_entries ae ON ae.entry_id = tep.entry_id
),
deduped AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY entry_id, poi_id
      ORDER BY source_rank, source_order, source_id
    ) AS poi_rank
  FROM combined
),
ranked AS (
  SELECT
    entry_id,
    poi_id,
    ROW_NUMBER() OVER (
      PARTITION BY entry_id
      ORDER BY source_rank, source_order, source_id
    ) AS sort_order,
    added_at,
    updated_at,
    description,
    note,
    reservation,
    reservation_url
  FROM deduped
  WHERE poi_rank = 1
)
SELECT * FROM ranked;

DELETE FROM trip_entry_pois
WHERE entry_id IN (SELECT DISTINCT entry_id FROM _m0059_canonical_entry_pois);

INSERT INTO trip_entry_pois (
  entry_id,
  poi_id,
  sort_order,
  added_at,
  updated_at,
  description,
  note,
  reservation,
  reservation_url
)
SELECT
  entry_id,
  poi_id,
  sort_order,
  added_at,
  updated_at,
  description,
  note,
  reservation,
  reservation_url
FROM _m0059_canonical_entry_pois
ORDER BY entry_id, sort_order;

UPDATE trip_entries
SET
  poi_id = (
    SELECT tep.poi_id
    FROM trip_entry_pois tep
    WHERE tep.entry_id = trip_entries.id
      AND tep.sort_order = 1
  ),
  entry_pois_version = entry_pois_version + 1
WHERE id IN (SELECT DISTINCT entry_id FROM _m0059_canonical_entry_pois);

DELETE FROM trip_pois
WHERE context = 'timeline';

DROP TABLE _m0059_canonical_entry_pois;

ANALYZE trip_entry_pois;
ANALYZE trip_pois;
