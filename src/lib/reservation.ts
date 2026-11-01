/**
 * reservation 欄位 helper — 修 trip_entry_pois.reservation 語意漂移。
 *
 * reservation 設計上是文字註解（type `string | null`），但 AI 生成路徑曾誤把結構化
 * 訂位狀態寫成 JSON 塞進此欄：
 *   {"available":"yes"|"no","method":"website"|"phone","url"|"phone":"…","recommended":bool}
 * 前端（TimelineRail / EditEntryPage）直接把 reservation 當字串印 → 露出 raw {...}。
 *
 * 兩個用途共用此 helper：
 *   - 一次性清理（scripts/normalize-reservation-json.ts）：JSON → 人話 append 進 note。
 *   - 寫入防堵（trip-pois PATCH/INSERT 路徑）：偵測 JSON → 轉文字放回 reservation。
 */

/**
 * 把「被誤存成 JSON 的 reservation」轉成人話文字。
 * 非 JSON-shaped（純文字註解 / 空 / 壞 JSON / 非 object）一律回 `null`（代表「不需轉」）。
 *
 * Shape → 文字：
 *   available:"no"                                  → 「不需訂位」
 *   available:"yes" + recommended + method+url/phone → 「建議網路預約：<url>」/「建議電話預約：<phone>」
 *   available:"yes" + recommended（無 detail）        → 「建議網路預約」/「建議電話預約」/「建議預約」
 *   available:"yes" 非 recommended                   → 「可…預約」
 */
export function reservationJsonToText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  // 只認「已知訂位狀態 shape」(available: 'yes'|'no')；其他 JSON（{}、別的結構、缺 available）
  // → null，不誤轉成假訂位文字（否則 A script 會 append 假字串 + 清空 reservation = 資料損毀）。
  if (o.available !== 'yes' && o.available !== 'no') return null;
  if (o.available === 'no') return '不需訂位';

  const recommended = o.recommended === true;
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const phone = typeof o.phone === 'string' ? o.phone.trim() : '';
  const detail = url || phone;
  const word = o.method === 'website' ? '網路預約' : o.method === 'phone' ? '電話預約' : '預約';
  const base = `${recommended ? '建議' : '可'}${word}`;
  return detail ? `${base}：${detail}` : base;
}

/** reservation 是否為「被誤存成 JSON」的值（開頭像 JSON 且能轉成文字）。 */
export function isJsonShapedReservation(raw: string | null | undefined): boolean {
  return reservationJsonToText(raw) !== null;
}

/**
 * 寫入防堵（D）：把任何要寫進 reservation 欄位的值正規化成文字。
 * JSON-shaped → 人話文字；純文字 → 原樣；null/undefined → null。
 * 用於所有接受 reservation 的 API 寫入點，防 AI 生成路徑再把 JSON 塞進此欄。
 */
export function normalizeReservation(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return reservationJsonToText(raw) ?? raw;
}
