-- v2.33.108: trip_entries.version + trip_segments.version OCC counter
--
-- Auto-save 編輯即儲存 UX 上線 — 移除「儲存」button，user 編輯後 onBlur/debounce
-- 即觸發 PATCH。多 device / 多 tab 同時編輯需 OCC version token 防 race
-- （v2.30.x P3 quick wins 已給 days + multi-POI 加 OCC，本次補 entries / segments）。
--
-- PATCH /trips/:id/entries/:eid 接受 optional expectedVersion，不符回 409
-- STALE_ENTRY，frontend autosave hook refresh version + retry once。
--
-- DEFAULT 0 + 既有 row 由 ALTER TABLE backfill。Frontend 沒帶 expectedVersion
-- = skip OCC check（向後相容）。
--
-- Deploy 順序：先 deploy backend（讀寫都接受 version 但 expectedVersion undefined
-- skip check），再 apply migration（新 row 加 version 欄）。30-90s race window
-- 內既有 row 仍 version=0 OK，新 row INSERT 自動帶 DEFAULT 0。

ALTER TABLE trip_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trip_segments ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
