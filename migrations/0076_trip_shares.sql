-- v2.39.0: trip_shares — 無登入公開分享連結（share platform）
--
-- Design doc: ~/.gstack/projects/raychiutw-trip-planner/ray-master-design-20260530-191308.md
-- Mockup sign-off (Variant B 分享封面): 2026-05-30
--
-- 一個行程可開 N 個不可猜的分享連結。公開 route /s/:token 無登入即可檢視
-- （重用 v2.36 列印文件）。owner/共編者管理連結，訪客可（PR3）一鍵複製。
--
-- 安全（見 design「安全設計」表 S1-S12）：
--   * token 只存 SHA-256 hash（raw token 不落 DB；DB leak 不洩 token）。
--   * visible_sections = JSON allowlist（只列要公開的 section key）→ default-deny：
--     公開端點只 SELECT 列在內的 note 區塊，關閉的區塊根本不查（非 fetch-then-strip）。
--   * expires_at = epoch ms（避開 D1 naive-datetime UTC 坑，v2.31.7）。
--   * revoke = set revoked_at（保留 view_count 分析）；delete = DROP row。

CREATE TABLE trip_shares (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id          TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,            -- SHA-256(raw token), hex
  label            TEXT NOT NULL DEFAULT '',        -- owner 自訂，如「給爸媽」
  visible_sections TEXT NOT NULL DEFAULT '[]',      -- JSON array：啟用的 note section key
                                                    -- (flights/lodgings/reservations/pretrip/emergency)
  expires_at       INTEGER,                         -- epoch ms；NULL = 永久
  view_count       INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL DEFAULT '',        -- 建立當下 user_id（顯示/稽核用，非授權依據）
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at       TEXT                             -- NULL = active；非 NULL = 已關閉
);

-- 公開查詢走 token_hash（UNIQUE 自帶 index）；管理列表走 trip_id。
CREATE INDEX idx_trip_shares_trip ON trip_shares(trip_id);
