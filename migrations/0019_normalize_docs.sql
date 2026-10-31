-- 正規化 trip_docs：移除 JSON content，拆成 relational tables
-- 舊表 trip_docs 的 content TEXT 欄位存 JSON string（雙重包裝）
-- 新表用獨立欄位，前端統一渲染

CREATE TABLE IF NOT EXISTS trip_docs_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('flights', 'checklist', 'backup', 'suggestions', 'emergency')),
  title       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trip_id, doc_type)
);

CREATE TABLE IF NOT EXISTS trip_doc_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id      INTEGER NOT NULL REFERENCES trip_docs_v2(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  section     TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_doc_entries_doc ON trip_doc_entries(doc_id);
