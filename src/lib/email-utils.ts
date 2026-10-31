/**
 * email-utils.ts — Unicode-correct email normalisation
 *
 * v2.33.59 round 13: 取代散落 `email.toLowerCase()` 比對。
 *
 * 為何不只 toLowerCase:
 *   - Turkish I/i locale-sensitive: `'İ'.toLowerCase()` 在 standard JS 返
 *     `'i̇'` (U+0069 + U+0307 combining dot)，不是 `'i'`。同 user 不同
 *     輸入路徑 (signup vs invite) 拿到不同字串 → 比對失敗。
 *   - Homograph: `payṗal.com` vs `paypal.com` 看似相同實際不同 codepoint。
 *   - 半形 / 全形 ＠ U+FF20 vs @ U+0040 — 若 input source 不一致也失敗。
 *
 * NFKC normalize 把 visually equivalent codepoint 統一 (combining chars
 * compose, full-width 變 ASCII)，再 toLowerCase casefold。
 *
 * Apply at:
 *   - 寫入端 (users.email INSERT, trip_invitations.invited_email INSERT)
 *   - 比對端 (invitation accept email check, permissions lookup)
 */

/**
 * 標準化 email — trim + NFKC + lowercase。Idempotent (normalize 已 normalize
 * 過的 email 結果相同)。用於寫入 + 比對兩端。
 *
 * v2.33.92 fix: 補 `.trim()` — 之前散落 callsites 都先 `.trim().toLowerCase()`，
 * v2.33.91 替換成 `normalizeEmail()` 後丟了 trim → 帶前後空白的 input 不再
 * 正規化（e.g. `'  user@x.com  '` ≠ stored `'user@x.com'`）。Trim 屬於 email
 * 比對 semantic 的一部分，集中在 helper 是正確的 SoT。
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase();
}
