-- Migration 0046: trip_ideas → saved_pois 概念合一 + V2 owner cutover phase 1
--
-- ## Phase 1 of 2 (phase 2 = migration 0047)
--
-- Phase 1 = ADD COLUMN + backfill + INSERT data + DROP trip_ideas (concept retire)
-- Phase 2 = DROP email columns + UNIQUE 改 user_id (must run AFTER prod 確認 code 100% 走 user_id-based auth)
--
-- ## 為什麼合在一個 PR / 兩個 migration files
--
-- D6=A approved: Big Bang 一個 PR、但拆兩個 migration files 讓 phase 2 可以
-- gate 在 manual `wrangler d1 migrations apply` 後（E-M5）。
-- Phase 1 idempotent + safe；phase 2 不可逆 (DROP COLUMN)，要 soak time。
--
-- ## Pre-flight gate (E-C1, E-H4)
--
-- 在 prod 跑此 migration **之前必須**：
--   1. `bun scripts/verify-user-backfill.ts` 對 prod PASS（0 orphans）
--   2. 紀錄 wrangler d1 time-travel bookmark 作 rollback point
-- 否則 backfill 後可能有 NULL owner_user_id 的 row，Phase 2 NEW TABLE 會 silently drop。
--
-- ## Must-fix integrations
--   - E-C3: trips.owner_user_id ON DELETE RESTRICT (NOT CASCADE) — 避免刪 user 連 trips/days/entries 一起消失
--   - E-M4: trip_ideas note + title 用 COALESCE 保留語意（避免純文字 idea 寫入空 note）
--   - E-H3: UNIQUE collision pre-flight 由 verify-user-backfill.ts 處理
--   - DX-C4: trip_requests.actions_taken column for audit log

-- =============================================
-- 1. trips: 加 owner_user_id (RESTRICT — E-C3)
-- =============================================

ALTER TABLE trips ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_trips_owner_user_id ON trips(owner_user_id);

-- =============================================
-- 2. Backfill 三表 user_id (email JOIN users)
-- =============================================

UPDATE trips
   SET owner_user_id = (SELECT id FROM users WHERE users.email = trips.owner)
 WHERE owner_user_id IS NULL;

UPDATE saved_pois
   SET user_id = (SELECT id FROM users WHERE users.email = saved_pois.email)
 WHERE user_id IS NULL;

UPDATE trip_permissions
   SET user_id = (SELECT id FROM users WHERE users.email = trip_permissions.email)
 WHERE user_id IS NULL AND email != '*';

-- =============================================
-- 3. trip_ideas → saved_pois 資料 migrate
--    僅 active (archived_at IS NULL) AND 未 promoted (promoted_to_entry_id IS NULL)
--    AND 有 poi_id (純文字 idea 丟棄，per Premise 2)
-- =============================================

INSERT OR IGNORE INTO saved_pois (user_id, email, poi_id, note, saved_at)
SELECT
  t.owner_user_id,
  t.owner,
  ti.poi_id,
  COALESCE(NULLIF(ti.note, ''), ti.title),  -- E-M4: 沒 note 用 title 補（保留 idea 文字）
  ti.added_at
FROM trip_ideas ti
JOIN trips t ON t.id = ti.trip_id
WHERE ti.archived_at IS NULL
  AND ti.promoted_to_entry_id IS NULL
  AND ti.poi_id IS NOT NULL
  AND t.owner_user_id IS NOT NULL;  -- 跳過 orphan trip owner（pre-flight 應已抓到）

-- =============================================
-- 4. Drop trip_ideas table + indexes
-- =============================================

DROP INDEX IF EXISTS idx_trip_ideas_archived;
DROP INDEX IF EXISTS idx_trip_ideas_poi;
DROP INDEX IF EXISTS idx_trip_ideas_trip;
DROP INDEX IF EXISTS idx_trip_ideas_added_by_user_id;
DROP TABLE IF EXISTS trip_ideas;

-- =============================================
-- 5. trip_requests.actions_taken (DX-C4 audit trail)
--    JSON string: [{ endpoint, method, payload_summary }, ...]
--    NULL = no actions taken (consultation reply only / dry-run)
--    讓 Ray grep 誤判 case + 給 Reply summary footer 渲染依據
-- =============================================

ALTER TABLE trip_requests ADD COLUMN actions_taken TEXT;
