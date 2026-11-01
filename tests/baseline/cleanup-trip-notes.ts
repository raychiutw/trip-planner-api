/**
 * 共用 D1 下，測試結束時清掉行程筆記測試建立的資料（依 trip id 的 LIKE 樣式與 email 樣式）。
 * 不依賴 FK cascade：notes 各表、AI job、trip_requests、audit_log 一律明確刪除。
 */
export async function cleanupTripNotes(db: D1Database, tripLikes: string[], emailLikes: string[] = []): Promise<void> {
  for (const like of tripLikes) {
    // trip_note_ai_jobs 要先於 trip_requests（FK）
    for (const table of ['trip_flights', 'trip_lodgings', 'trip_reservations', 'trip_pretrip_notes', 'trip_emergency_contacts', 'trip_note_ai_jobs', 'trip_note_ai_exclusions', 'trip_requests', 'audit_log', 'trip_days', 'trip_permissions']) {
      await db.prepare(`DELETE FROM ${table} WHERE trip_id LIKE ?`).bind(like).run();
    }
    await db.prepare('DELETE FROM trips WHERE id LIKE ?').bind(like).run();
  }
  for (const like of emailLikes) {
    await db.prepare('DELETE FROM users WHERE email LIKE ?').bind(like).run();
  }
}
