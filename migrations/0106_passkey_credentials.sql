-- passkey（WebAuthn）憑證儲存（spec trip-planner#1677、ADR-0016）。只新增表，不動既有資料。
--
-- id：憑證 ID（base64url，authenticator 產生，全域唯一）。
-- public_key：COSE 公鑰（base64url）；alg：COSE 演算法編號（目前只收 -7＝ES256）。
-- sign_count：簽名計數，登入時用來偵測被複製的憑證。
-- transports：JSON 陣列（internal／hybrid／usb…），登入時回給瀏覽器提示用。
-- backup_eligible／backed_up：authenticatorData 的 BE／BS 旗標（是否為可同步的 passkey）。
-- 刪帳號時由 erasure 顯式清除（見 src/lib/erasure.ts）；註冊挑戰存在 oauth_models，不另開表。

CREATE TABLE passkey_credentials (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  alg             INTEGER NOT NULL,
  sign_count      INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  transports      TEXT,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up       INTEGER NOT NULL DEFAULT 0,
  aaguid          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at    TEXT
);

CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);
