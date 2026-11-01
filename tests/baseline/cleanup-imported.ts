import { cleanupTrips } from './cleanup-trips';

/**
 * 共用 D1 下，清掉某位匯入者（owner email）透過 API 建立的所有行程與附屬資料。
 * 行程 id 由後端產生，所以以 owner 找出；POI 以名稱樣式清除。
 */
export async function cleanupImportedTrips(db: D1Database, ownerEmail: string, poiNameLikes: string[]): Promise<void> {
  const owned = await db
    .prepare('SELECT t.id FROM trips t JOIN users u ON u.id = t.owner_user_id WHERE u.email = ?')
    .bind(ownerEmail)
    .all<{ id: string }>();
  const ids = owned.results.map((r) => r.id);
  for (const id of ids) {
    for (const table of [
      'trip_destinations', 'trip_pretrip_notes', 'trip_flights', 'trip_lodgings',
      'trip_reservations', 'trip_emergency_contacts', 'audit_log',
    ]) {
      await db.prepare(`DELETE FROM ${table} WHERE trip_id = ?`).bind(id).run();
    }
  }
  await cleanupTrips(db, ids, poiNameLikes);
}
