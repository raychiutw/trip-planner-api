/**
 * D1 `datetime('now')` 回傳 `YYYY-MM-DD HH:MM:SS` 字串（UTC）但無時區後綴。
 * 直接 `new Date(s)` 各家瀏覽器規格不一：Chrome/Safari 多半當 local time → 顯示
 * 落差 TZ offset 小時（v2.31.6 prod QA 抓到「8 小時前完成」實際 7 分鐘 bug）。
 *
 * 修法：偵測 D1 naive datetime → 補 'Z' 後綴 → 強制 UTC parse。
 * ISO 8601 含 'T' 或 'Z' / '+' 的字串原樣 pass-through（避免重複加 Z）。
 *
 * `null` / `undefined` / 不合法字串回 `null`。
 */
export function parseUtcDate(input: string | null | undefined): Date | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // D1 naive datetime: 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD HH:MM:SS.SSS'
  // 沒 'T'、沒 'Z'、沒 '+/-' 時區 → 視作 UTC，補 Z。
  const isNaive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed);
  const normalized = isNaive ? trimmed.replace(' ', 'T') + 'Z' : trimmed;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
