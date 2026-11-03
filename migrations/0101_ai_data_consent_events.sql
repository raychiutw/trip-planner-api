-- AI 資料同意（spec #1553、ADR-0012）：只追加的事件表。
-- 同意狀態（none／valid／stale／withdrawn）由「該使用者最新一筆事件（最大 id）」推導；不改寫、不刪除歷史（稽核）。
-- 不存行程內容或任何秘密：只記誰、哪一版、何時、接受或撤回。
-- 與既有的 OAuth Consent（oauth_models）、AI 操作授權（tripline-tp-request 的 Consent）各自獨立，不回填。
-- 使用者刪除帳號時連動清掉（ON DELETE CASCADE）。純新增，不動既有資料表。
CREATE TABLE ai_data_consent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('accepted', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_ai_data_consent_user_id ON ai_data_consent_events (user_id, id);
