-- Migration 0070 — v2.33.60 round 14: 修補 0047 backup-restore 漏 sqlite_sequence
--
-- Round 14 code-review HIGH: migration 0047 用 _backup_X swap pattern 把 child
-- tables 重建，但漏掉 sqlite_sequence preserve。AUTOINCREMENT cols 後續 INSERT
-- 可能拿到既有 max(id) — 雖然 PK UNIQUE 會擋，但跑 INSERT OR REPLACE 或 INSERT OR
-- IGNORE 的 path 會 silent 覆寫。
--
-- 受影響 table (受 0047 backup-restore swap 影響 + 仍存在 + AUTOINCREMENT id):
--   trip_days, trip_entries, trip_destinations, trip_docs, trip_doc_entries。
--   trip_pois 已 DROP in 0062 — skip。
--   trip_invitations PK 是 token_hash (TEXT) 無 AUTOINCREMENT — skip。
--
-- 修法: 對每個受影響 table SET sqlite_sequence.seq = MAX(id)。idempotent —
-- 多次跑結果一樣，安全。已經正確的 case (seq >= max id) 無變化。
--
-- 注意: sqlite_sequence 是 SQLite 系統表，用 INSERT OR REPLACE 確保 row 存在。

INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'trip_days', COALESCE(MAX(id), 0) FROM trip_days;

INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'trip_entries', COALESCE(MAX(id), 0) FROM trip_entries;

INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'trip_destinations', COALESCE(MAX(id), 0) FROM trip_destinations;

INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'trip_docs', COALESCE(MAX(id), 0) FROM trip_docs;

INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'trip_doc_entries', COALESCE(MAX(id), 0) FROM trip_doc_entries;
