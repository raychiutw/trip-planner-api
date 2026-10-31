-- Migration 0037: session_devices — V2-P6 multi-device session tracking
--
-- Each issueSession 寫一 row。支援 user 在 /settings/sessions 看見所有 active
-- session + 遠端登出。
--
-- ## Why this design (vs storing whole session in DB)
--
-- 還是用 HMAC opaque cookie token + sid 嵌進 payload 而非 DB-only session。
-- 理由：
--   - HMAC verify 不需 DB 讀（constant time，無 latency）
--   - DB 只在 revocation check 時讀（仍是 D1 ms-level）
--   - 即使 D1 失敗（rare），cookie 仍能 verify → degrade gracefully
--   - revocation 不立即生效（需 lookup）— acceptable since 1h scenario
--
-- ## Privacy
--
-- ip_hash 是 SHA-256(ip) **unsalted** — 跟 auth_audit_log 一致。**不存 plain IP**，
-- 但 attacker with DB dump 可 rainbow-table 反查（IPv4 4B entries 秒級）。Threat
-- model 接受：DB dump = 已 full compromise，IP 反查不是 incremental risk。
-- API response 只 leak ip_hash 前 8 base64 char (~48 bits) 做「同 device 提示」，
-- 不足以單獨反查單一 IP（48 bits prefix collide ~10s of IPv4）。
-- 若未來需要 GDPR-grade de-identification，加 SESSION_IP_HASH_SECRET env 改 keyed
-- hash (HMAC-SHA-256(secret, ip)) — V2-P7 task。
-- city/country 留 NULL（V2-P6 future 加 GeoIP enrichment）。
-- ua_summary 從 User-Agent parse 「Browser · OS」（client-side display 用）。
--
-- ## Revocation eventual consistency
--
-- 撤銷不立即生效。Logout / DELETE /sessions/:sid 寫 revoked_at 後，仍在 in-flight
-- 的 getSessionUser 可能 race condition 撐過下一個 request（read-after-write lag
-- ~tens of ms in D1）。Acceptable trade-off for "best-effort eventual" model。
-- 真正立即撤銷需 storage-level fence（D1 不提供）— V2-P7 改 Durable Object
-- 才能 strong consistency。
--
-- ## Cleanup
--
-- V2-P6 cron 30 天 cleanup：DELETE WHERE revoked_at IS NOT NULL OR
-- (revoked_at IS NULL AND last_seen_at < datetime('now', '-30 days'))。
-- 過期 cookie 已被 verifySessionToken 拒，但 row 留太久浪費空間。

CREATE TABLE session_devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sid             TEXT NOT NULL UNIQUE,                    -- session id 嵌 cookie payload
  user_id         TEXT NOT NULL,                            -- 對應 users.id (no FK 防 cascade race)
  ua_summary      TEXT,                                     -- 'Chrome · macOS 15'，client-friendly
  ip_hash         TEXT,                                     -- SHA-256(ip) base64
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at      TEXT
);

-- sid lookup is covered by the implicit UNIQUE index on `sid TEXT NOT NULL UNIQUE`
-- (SQLite auto-creates one). No separate single-column index needed.
CREATE INDEX idx_session_devices_user_active
  ON session_devices(user_id, revoked_at, last_seen_at);
