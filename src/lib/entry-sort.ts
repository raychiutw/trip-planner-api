/**
 * resortDayByArrival — 依 start_time 升冪重排某日 entries 的 sort_order（單一原子 SQL）。
 *
 * 觸發時機（僅互動入口）：改景點時間、互動新增景點後。手動拖曳（走 batch 端點顯式
 * 設 sort_order）不經過這裡，維持使用者手排順序。bulk 建立（import / clone / copy）
 * 亦不接，避免逐筆重排造成 O(n²) 寫入。
 *
 * 排序鍵（ROW_NUMBER OVER ORDER BY）：
 *   1. 無 start_time（NULL 或 ''）者殿後（`(start_time IS NULL OR start_time='') ASC` → 0 先 1 後）。
 *   2. `NULLIF(start_time,'')` 升冪 = 同日時序（"HH:MM" 補零，字典序即時序）。**用 NULLIF 把
 *      '' 收斂成 NULL**：否則 SQLite ORDER BY 中 NULL < ''，同為「無時間」的 NULL 列會浮到 ''
 *      列之上、蓋過 #3 的 sort_order stable tiebreak（混合 NULL/'' 資料會亂序，Codex review 實測）。
 *   3. 原 sort_order 升冪 → 同時間 / 皆無時間時保持原相對順序（stable）。
 *   `rank - 1` → 0-based，對齊 drag/batch 的 sort_order 慣例。
 *
 * 為何單一 `UPDATE ... FROM (...)`（而非 SELECT-then-batch）：
 *   - **race-free**：SELECT-then-batch 的兩個 await 間有 read-modify-write 視窗，兩個併發
 *     改時間可互相覆蓋 sort_order（Codex review 指出）；單一語句由 SQLite 原子計算 rank，
 *     無視窗。
 *   - **無寫入放大**：`WHERE sort_order <> rank` 只改「順序真的變」的 row → 已時序的天
 *     （含 AI 逐筆批建）0 row 更新，AI 建 N 筆不會 O(n²) 寫。
 *   - schema 無 (day_id, sort_order) unique index → 語句內暫態衝突允許。
 *
 * ponytail: HH:MM 字典序 = 同日時序；把凌晨當隔日的跨午夜情境不在單日模型內。
 *
 * @returns true 表示有 row 的 sort_order 被改（`meta.changes > 0`）；false = 已時序 / 無變動。
 */
export async function resortDayByArrival(db: D1Database, dayId: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE trip_entries AS te
          SET sort_order = r.rank
         FROM (
           SELECT id, ROW_NUMBER() OVER (
             ORDER BY (start_time IS NULL OR start_time = '') ASC, NULLIF(start_time, '') ASC, sort_order ASC
           ) - 1 AS rank
             FROM trip_entries
            WHERE day_id = ?
         ) AS r
        WHERE te.id = r.id AND te.sort_order <> r.rank`,
    )
    .bind(dayId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
