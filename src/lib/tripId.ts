/**
 * 行程 ID 產生 — 前端建立與後端匯入的**單一來源**。
 *
 * 2026-07-21 之前這裡有兩份互不相干的實作：`NewTripPage.tsx` 的
 * `genTripId()`（`台北` → `trip-bp5o`）與 `functions/api/trips/import.ts` 的
 * `imp-${crypto.randomUUID()}`（→ `imp-62a83969-2dd2-47f3-bbb6-2fe549455081`）。
 * 同一個系統長出兩種 ID 慣例，URL 長度差四倍。`imp-` 前綴全專案無人讀取，
 * 純粹是分歧而非設計。
 *
 * 後綴用 crypto 亂數而非時間戳：前端原本是 `Date.now().toString(36).slice(-4)`，
 * 同毫秒兩次呼叫會產生相同字串。前端一次只建一個行程所以沒暴露問題，但匯入
 * 路徑沒有 `POST /api/trips` 那道 `SELECT 1 FROM trips WHERE id` 重複檢查，
 * 撞上直接噴 D1 UNIQUE。統一成亂數後綴即可同時滿足可讀性與碰撞安全。
 *
 * 放在 `src/lib/` 而非 `functions/`：Pages Functions 已有 import `src/` 的前例
 * （`src/server/password.ts`），反向則不成立。
 */

/** 行程 ID 長度上限（對齊 trips.id 的既有慣例與 URL 可讀性）。 */
export const TRIP_ID_MAX_LEN = 100;

/** 亂數後綴長度。36^8 ≈ 2.8 兆，遠超過任何實際的行程建立量。 */
const SUFFIX_LEN = 8;

/**
 * 把行程名稱轉成 URL 安全的 slug。
 *
 * 中文／日文名稱會被 `[^a-z0-9]` 濾光而回傳 `'trip'` —— 這不是 bug，是既有
 * 行為，prod 上的 `trip-bp5o`（台北）、`trip-me4p`（東京）就是這樣來的。
 * 保留此行為以免既有行程與新行程看起來像兩套系統。
 */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      // 去除 NFKD 拆出來的組合用變音符號（Café → cafe）
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'trip'
  );
}

/** base36 亂數後綴。瀏覽器與 Workers runtime 都有 Web Crypto。 */
function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LEN);
  crypto.getRandomValues(bytes);
  // 每 byte 取 mod 36 會有極輕微偏差（256 不是 36 的倍數），對 ID 唯一性無影響。
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

/**
 * 產生行程 ID：`<slug>-<亂數後綴>`。
 *
 * 截斷發生在 slug 上而非整串尾端 —— 直接砍整串會把後綴切短甚至切光，
 * 那正是碰撞安全所依賴的部分。
 */
export function genTripId(name: string): string {
  const suffix = randomSuffix();
  const maxSlug = TRIP_ID_MAX_LEN - suffix.length - 1; // -1 給連接的連字號
  const slug = slugify(name).slice(0, maxSlug).replace(/-+$/, '') || 'trip';
  return `${slug}-${suffix}`;
}
