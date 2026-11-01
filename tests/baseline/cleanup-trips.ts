/**
 * 共用 D1 下，測試結束時清掉自己建立的行程資料（依 trip id 的 LIKE 樣式）。
 * 只刪屬於這些 trip 的列；POI 另以名稱樣式清除（pois 沒有 trip 歸屬）。
 */
export async function cleanupTrips(db: D1Database, tripLikes: string[], poiNameLikes: string[] = []): Promise<void> {
  for (const like of tripLikes) {
    const dayIds = 'SELECT id FROM trip_days WHERE trip_id LIKE ?';
    const entryIds = `SELECT id FROM trip_entries WHERE day_id IN (${dayIds})`;
    await db.prepare('DELETE FROM trip_segments WHERE trip_id LIKE ?').bind(like).run();
    await db.prepare(`DELETE FROM trip_entry_pois WHERE entry_id IN (${entryIds})`).bind(like).run();
    await db.prepare(`DELETE FROM trip_entries WHERE day_id IN (${dayIds})`).bind(like).run();
    await db.prepare('DELETE FROM trip_days WHERE trip_id LIKE ?').bind(like).run();
    await db.prepare('DELETE FROM trip_permissions WHERE trip_id LIKE ?').bind(like).run();
    await db.prepare('DELETE FROM trips WHERE id LIKE ?').bind(like).run();
  }
  for (const like of poiNameLikes) {
    await db.prepare('DELETE FROM pois WHERE name LIKE ?').bind(like).run();
  }
}
