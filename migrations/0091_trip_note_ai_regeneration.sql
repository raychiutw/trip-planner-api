-- 0091 — 行程筆記 AI 重新生成、人工維護與排除 tombstone

ALTER TABLE trip_pretrip_notes
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'
  CHECK(origin IN ('human', 'ai'));
ALTER TABLE trip_pretrip_notes
  ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'human'
  CHECK(managed_by IN ('human', 'ai'));
ALTER TABLE trip_pretrip_notes ADD COLUMN semantic_key TEXT;

ALTER TABLE trip_emergency_contacts
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'
  CHECK(origin IN ('human', 'ai'));
ALTER TABLE trip_emergency_contacts
  ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'human'
  CHECK(managed_by IN ('human', 'ai'));
ALTER TABLE trip_emergency_contacts ADD COLUMN semantic_key TEXT;

-- 舊 ai_generated 資料的來源可確定；只有找不到人工 update audit 的資料才交由 AI 維護。
UPDATE trip_pretrip_notes
SET origin = 'ai',
    managed_by = CASE
      WHEN EXISTS (
        SELECT 1 FROM audit_log
        WHERE table_name = 'trip_pretrip_notes'
          AND record_id = trip_pretrip_notes.id
          AND action = 'update'
          AND COALESCE(changed_by, '') NOT LIKE 'ai:%'
          AND COALESCE(changed_by, '') <> 'system:ai'
      ) THEN 'human'
      ELSE 'ai'
    END
WHERE ai_generated = 1;

UPDATE trip_emergency_contacts
SET origin = 'ai',
    managed_by = CASE
      WHEN EXISTS (
        SELECT 1 FROM audit_log
        WHERE table_name = 'trip_emergency_contacts'
          AND record_id = trip_emergency_contacts.id
          AND action = 'update'
          AND COALESCE(changed_by, '') NOT LIKE 'ai:%'
          AND COALESCE(changed_by, '') <> 'system:ai'
      ) THEN 'human'
      ELSE 'ai'
    END
WHERE ai_generated = 1;

CREATE TABLE trip_note_ai_exclusions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL CHECK(doc_type IN ('lodging-tips', 'tips', 'emergency')),
  semantic_key  TEXT NOT NULL,
  label         TEXT NOT NULL,
  deleted_by    TEXT,
  deleted_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_trip_note_ai_exclusions_unique
  ON trip_note_ai_exclusions(trip_id, doc_type, semantic_key);
CREATE INDEX idx_trip_note_ai_exclusions_trip
  ON trip_note_ai_exclusions(trip_id, doc_type, deleted_at DESC);

DROP INDEX idx_trip_note_ai_jobs_request;
DROP INDEX idx_trip_note_ai_jobs_trip;
ALTER TABLE trip_note_ai_jobs RENAME TO trip_note_ai_jobs_0090;

CREATE TABLE trip_note_ai_jobs (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id                INTEGER NOT NULL UNIQUE REFERENCES trip_requests(id) ON DELETE CASCADE,
  trip_id                   TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  doc_type                  TEXT NOT NULL CHECK(doc_type IN ('lodging-tips', 'tips', 'emergency')),
  generation                INTEGER NOT NULL DEFAULT 1,
  status                    TEXT NOT NULL
                            CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'timed_out'))
                            DEFAULT 'pending',
  inserted_count            INTEGER NOT NULL DEFAULT 0,
  replaced_count            INTEGER NOT NULL DEFAULT 0,
  preserved_manual_count    INTEGER NOT NULL DEFAULT 0,
  duplicate_excluded_count  INTEGER NOT NULL DEFAULT 0,
  suppressed_count          INTEGER NOT NULL DEFAULT 0,
  error_code                TEXT,
  error_message             TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  started_at                TEXT,
  timeout_at                TEXT NOT NULL DEFAULT (datetime('now', '+10 minutes')),
  completed_at              TEXT
);

INSERT INTO trip_note_ai_jobs (
  id, request_id, trip_id, doc_type, generation, status,
  inserted_count, error_code, error_message,
  created_at, timeout_at, completed_at
)
SELECT
  old.id,
  old.request_id,
  old.trip_id,
  old.doc_type,
  (
    SELECT COUNT(*)
    FROM trip_note_ai_jobs_0090 AS prior
    WHERE prior.trip_id = old.trip_id
      AND prior.doc_type = old.doc_type
      AND (
        prior.created_at < old.created_at
        OR (prior.created_at = old.created_at AND prior.id <= old.id)
      )
  ),
  CASE
    WHEN old.status = 'pending'
      AND old.id <> (
        SELECT MAX(active.id)
        FROM trip_note_ai_jobs_0090 AS active
        WHERE active.trip_id = old.trip_id
          AND active.doc_type = old.doc_type
          AND active.status = 'pending'
      )
    THEN 'timed_out'
    ELSE old.status
  END,
  old.inserted_count,
  CASE WHEN old.status = 'failed' THEN 'NOTES_AI_APPLY_FAILED' END,
  old.error_message,
  old.created_at,
  datetime(old.created_at, '+10 minutes'),
  CASE
    WHEN old.status = 'pending'
      AND old.id <> (
        SELECT MAX(active.id)
        FROM trip_note_ai_jobs_0090 AS active
        WHERE active.trip_id = old.trip_id
          AND active.doc_type = old.doc_type
          AND active.status = 'pending'
      )
    THEN COALESCE(old.completed_at, datetime('now'))
    ELSE old.completed_at
  END
FROM trip_note_ai_jobs_0090 AS old;

DROP TABLE trip_note_ai_jobs_0090;

CREATE INDEX idx_trip_note_ai_jobs_trip
  ON trip_note_ai_jobs(trip_id, doc_type, generation DESC);
CREATE INDEX idx_trip_note_ai_jobs_request
  ON trip_note_ai_jobs(request_id);
CREATE UNIQUE INDEX idx_trip_note_ai_jobs_active
  ON trip_note_ai_jobs(trip_id, doc_type)
  WHERE status IN ('pending', 'processing');
