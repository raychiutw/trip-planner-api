-- Migration 0050: rename saved_pois → poi_favorites + companion_request_actions + audit_log column
--
-- Strategy: expand-contract pattern phase 1
--   - CREATE poi_favorites (schema 同 saved_pois，column 名 saved_at → favorited_at)
--   - INSERT INTO poi_favorites SELECT FROM saved_pois (複製資料)
--   - 不動 saved_pois — 此 PR DELETE 舊 handler files (functions/api/saved-pois*)，
--     code-level dual-read 已不存在；表保留只為「migration apply 早於 code deploy」
--     deploy-window race（避免 5xx 窗口）+ rollback 期間舊 code revert 後可重新讀。
--     注意：deploy-window 內若舊 code 仍寫 saved_pois，這些 INSERT 不會自動鏡像到
--     poi_favorites（無 trigger）— 後續 cleanup PR (0051) DROP 前需重跑 INSERT SELECT
--     補齊或 accept drift（drift 視窗短，僅 deploy 期間幾秒）。
--   - 後續 PR (migration 0051, soak ≥ 1 week) DROP TABLE saved_pois
--
-- Rationale: 避免 GitHub Actions deploy.yml migration → app deploy 順序造成 5xx 窗口
--   (autoplan Phase 3 EC2 critical finding)。expand-contract 在 D1 single-writer 環境
--   下是 zero-downtime 標準解。
--
-- Companion mapping infrastructure（poi-favorites-rename change）：
--   - companion_request_actions: 限制 1 request : 1 action（防同 requestId 灌爆 favorites pool）
--   - audit_log.companion_failure_reason: server 端 differentiated log（client 維持 401 uniform）

-- =============================================
-- 1. poi_favorites — POI 收藏池新表（取代 saved_pois）
-- =============================================
-- saved_pois 沒 children FK 依賴，純 CREATE 安全。FK ON DELETE CASCADE 對齊既有 saved_pois 行為。

CREATE TABLE poi_favorites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poi_id       INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  favorited_at TEXT NOT NULL DEFAULT (datetime('now')),
  note         TEXT,
  UNIQUE (user_id, poi_id)
);

-- UNIQUE (user_id, poi_id) auto-creates index covering user_id lookups, only need poi_id index.
CREATE INDEX idx_poi_favorites_poi ON poi_favorites(poi_id);

-- =============================================
-- 2. companion_request_actions — companion mapping 操作 log
-- =============================================
-- UNIQUE (request_id, action) 防同 requestId 重複寫不同 poiId（攻擊面：service token 用同
-- requestId POST 100 個 poiId 灌爆 victim's favorites pool）。每 request 對每 action 只能 1 筆。

CREATE TABLE companion_request_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES trip_requests(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('favorite_create','favorite_delete','add_to_trip')),
  poi_id     INTEGER REFERENCES pois(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, action)
);

CREATE INDEX idx_companion_request_actions_request ON companion_request_actions(request_id);

-- =============================================
-- 3. audit_log: 加 companion_failure_reason TEXT column
-- =============================================
-- enum values: invalid_request_id / status_completed / submitter_unknown /
--              self_reported_scope / client_unauthorized / quota_exceeded
-- nullable: 一般 audit 不寫，僅 companion path 失敗時 server log 用

ALTER TABLE audit_log ADD COLUMN companion_failure_reason TEXT;

-- =============================================
-- 4. 複製 saved_pois 資料到 poi_favorites（dual-table phase）
-- =============================================
-- column rename: saved_at → favorited_at（INSERT SELECT 用 alias 對映）
-- id 保留同值，避免 cross-reference 失效

INSERT INTO poi_favorites (id, user_id, poi_id, favorited_at, note)
SELECT id, user_id, poi_id, saved_at, note FROM saved_pois;

-- =============================================
-- 5. 重整 query planner stats
-- =============================================

ANALYZE poi_favorites;
ANALYZE companion_request_actions;
ANALYZE audit_log;
