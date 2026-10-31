/**
 * PII 遮罩工具 — 用於對外告警與稽核 metadata。
 *
 * 背景（2026-07-20 隱私盤點）：
 *   - Telegram 管理者告警把使用者 email 送到境外 bot 聊天群（非端對端加密）。
 *     其中 `permissions.ts` 送的是**被邀請的第三方** email —— 那人甚至還不是使用者，
 *     從沒同意過任何條款。
 *   - `forgot-password.ts` 把明文 email 塞進 `auth_audit_log.metadata`。
 *
 * 診斷時仍需要知道「是哪個帳號出問題」，所以不是整個拿掉，而是遮罩成
 * **可辨識但不可還原**的形式：保留首字與網域，足以在支援情境對上人，
 * 又不構成可直接使用的聯絡方式。
 */

/**
 * 遮罩 email：`raychiu@example.com` → `r***@example.com`
 *
 * - local part ≤1 字元時**不留首字**（`a@x.com` → `***@x.com`），
 *   否則等於揭露完整 local part。
 * - 非 email 字串回 `'***'`，不拋錯 —— 告警路徑不該因為遮罩失敗而中斷。
 * - 先正規化大小寫與空白，避免同一個人在紀錄中出現多種遮罩形式而無法比對。
 */
export function maskEmail(raw: string | null | undefined): string {
  if (!raw) return '***';
  const value = raw.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain.includes('.')) return '***';

  // 只有 1 個字元就不留 —— 留了等於沒遮。
  const head = local.length > 1 ? local[0] : '';
  return `${head}***@${domain}`;
}
