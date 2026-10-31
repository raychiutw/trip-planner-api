-- v2.34.0: 行程筆記（Trip Notes）— 5 個 trip-level note table + 1 個 AI linkage table
--
-- Design doc: ~/.gstack/projects/raychiutw-trip-planner/ray-master-design-20260528-144009.md
-- Mockup sign-off (V1 Accordion Stack): 2026-05-28
--   docs/design-sessions/2026-05-28-trip-notes/v1-accordion-stack.html (IA)
--   docs/design-sessions/2026-05-28-trip-notes/v1-states.html (state matrix + audit fix)
--
-- 5 個 user-facing section（航班 / 住宿 / 預訂 / 行前須知 / 緊急聯絡）+ 1 個 AI linkage table
-- 對齊 v2.33.102 CR-8 confused-deputy fix pattern（health-check linkage）— 避免 prefix sniffing。
--
-- 每個 table 含 version OCC counter 對齊 v2.33.108 trip_entries / trip_segments pattern：
-- autosave PATCH 接受 optional expectedVersion，不符回 409 STALE_<NAME>，前端 refresh + retry。
--
-- AI 只生 3 個 prompt prefix（lodging-tips / tips / emergency）寫進 2 個 section
-- （trip_pretrip_notes + trip_emergency_contacts）。lodging-tips 與 general-tips
-- 都進 trip_pretrip_notes，靠 ai_source 區分避免 dedup 互相污染。

-- (1) 航班 — 純手動，不 AI
CREATE TABLE trip_flights (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  airline         TEXT NOT NULL DEFAULT '',
  flight_no       TEXT NOT NULL DEFAULT '',
  cabin_class     TEXT NOT NULL DEFAULT '',
  depart_airport  TEXT NOT NULL DEFAULT '',
  arrive_airport  TEXT NOT NULL DEFAULT '',
  depart_at       TEXT NOT NULL DEFAULT '',  -- ISO8601 local datetime
  arrive_at       TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trip_flights_trip ON trip_flights(trip_id, sort_order);

-- (2) 住宿 — 純手動，可選 link 到第一個 hosted day 供 reverse navigation
CREATE TABLE trip_lodgings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  check_in_at     TEXT NOT NULL DEFAULT '',
  check_out_at    TEXT NOT NULL DEFAULT '',
  booking_no      TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  -- day_id nullable + SET NULL：lodging 可未 link day（規劃中）/ link day 被刪後保留 row 變 unlinked
  day_id          INTEGER REFERENCES trip_days(id) ON DELETE SET NULL,
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trip_lodgings_trip ON trip_lodgings(trip_id, sort_order);
CREATE INDEX idx_trip_lodgings_day ON trip_lodgings(day_id) WHERE day_id IS NOT NULL;

-- (3) 預訂 — 純手動，餐廳 / 體驗 / 票券通用
CREATE TABLE trip_reservations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  kind            TEXT NOT NULL CHECK(kind IN ('restaurant','experience','ticket','transport','other')) DEFAULT 'restaurant',
  title           TEXT NOT NULL DEFAULT '',
  reserved_at     TEXT NOT NULL DEFAULT '',
  party_size      INTEGER NOT NULL DEFAULT 0,
  reservation_no  TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trip_reservations_trip ON trip_reservations(trip_id, sort_order);

-- (4) 行前須知 — AI 可生（lodging-tips + general-tips 兩個 prompt 共用此表，ai_source 區分）
CREATE TABLE trip_pretrip_notes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  section         TEXT NOT NULL DEFAULT '',  -- e.g. '貨幣' / '插座' / '簽證' / '通訊' / '禮儀'
  title           TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',  -- markdown text，非 JSON
  ai_generated    INTEGER NOT NULL DEFAULT 0,  -- 0=manual, 1=AI
  ai_source       TEXT,  -- NULL=manual, 'lodging-tips' / 'general-tips'；dedup 必須 filter 避免兩 prompt 互相污染
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trip_pretrip_notes_trip ON trip_pretrip_notes(trip_id, sort_order);
CREATE INDEX idx_trip_pretrip_notes_ai_source ON trip_pretrip_notes(trip_id, ai_source) WHERE ai_source IS NOT NULL;

-- (5) 緊急聯絡 — AI 可生（emergency prompt）
CREATE TABLE trip_emergency_contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL DEFAULT '',
  relationship    TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL CHECK(kind IN ('personal','embassy','police','medical','insurance','hotel','other')) DEFAULT 'other',
  ai_generated    INTEGER NOT NULL DEFAULT 0,
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trip_emergency_contacts_trip ON trip_emergency_contacts(trip_id, sort_order);

-- (6) AI 生成 linkage table — 對齊 v2.33.102 CR-8 trip_health_reports.request_id pattern
-- PATCH /api/requests/:id 完成 hook 用 `SELECT 1 FROM trip_note_ai_jobs WHERE request_id = ?`
-- 識別 notes generation，路由到 applyNotesGenerationCompletion(doc_type, findings)。
-- 避免 v2.33.27 prefix sniffing pattern 的 confused deputy 風險。
CREATE TABLE trip_note_ai_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      INTEGER NOT NULL UNIQUE REFERENCES trip_requests(id) ON DELETE CASCADE,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK(doc_type IN ('lodging-tips','tips','emergency')),
  status          TEXT NOT NULL CHECK(status IN ('pending','completed','failed')) DEFAULT 'pending',
  inserted_count  INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);
CREATE INDEX idx_trip_note_ai_jobs_trip ON trip_note_ai_jobs(trip_id, doc_type);
CREATE INDEX idx_trip_note_ai_jobs_request ON trip_note_ai_jobs(request_id);
