-- Migration 0033: 加 user_id columns to email-keyed tables (V2-P1 backfill prep)
--
-- V2-P1 Google login 後 users + auth_identities 有 row。既有 trips ownership
-- 用 email column 當 anchor（saved_pois.email / trip_permissions.email /
-- trip_ideas.added_by），這個 migration 加 user_id FK column 預備 backfill。
--
-- 策略：
--   1. 此 migration: ADD COLUMN user_id ... NULL (FK 但 nullable)
--   2. 下個 migration / 一次性 script: 對每個 row，查 email → users.id，
--      populate user_id (跑在 prod 才有 user 後)
--   3. V2-P2 / V2-P3：UPDATE 完成後改 NOT NULL（cutover 點，需 zero-downtime
--      pattern：deploy code that writes both columns，等 backfill 完，再 drop email）
--
-- 為何不直接 NOT NULL：既有 row 沒對應 user_id，加 NOT NULL 會 fail。
-- 必須先 nullable + backfill + NOT NULL three-step migration pattern。
--
-- ON DELETE 行為：
--   saved_pois / trip_permissions: CASCADE（user 被刪，pool / permission 一起清）
--   trip_ideas: SET NULL（user 被刪，idea 文字保留 audit 用）

ALTER TABLE saved_pois
  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE trip_permissions
  ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE trip_ideas
  ADD COLUMN added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_saved_pois_user_id ON saved_pois(user_id);
CREATE INDEX idx_trip_permissions_user_id ON trip_permissions(user_id);
CREATE INDEX idx_trip_ideas_added_by_user_id ON trip_ideas(added_by_user_id);
