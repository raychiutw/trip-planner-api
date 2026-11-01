/**
 * 共用 D1 下，清掉行程筆記測試自己建立的資料。`prefix` 同時是 trip id 與 owner email 的專屬前綴
 * （前綴不含 `_` 與 `%`）。刪除順序依外鍵：先子表（jobs、筆記列、排除、稽核），再 request，最後行程。
 */
import { cleanupTrips } from './cleanup-trips';

export async function cleanupNotes(db: D1Database, prefix: string): Promise<void> {
  const like = `${prefix}%`;
  await db.prepare('DELETE FROM trip_note_ai_jobs WHERE trip_id LIKE ?').bind(like).run();
  await db.prepare('DELETE FROM trip_note_ai_exclusions WHERE trip_id LIKE ?').bind(like).run();
  await db.prepare('DELETE FROM trip_pretrip_notes WHERE trip_id LIKE ?').bind(like).run();
  await db.prepare('DELETE FROM trip_emergency_contacts WHERE trip_id LIKE ?').bind(like).run();
  await db.prepare('DELETE FROM audit_log WHERE trip_id LIKE ?').bind(like).run();
  await db.prepare('DELETE FROM trip_requests WHERE trip_id LIKE ?').bind(like).run();
  await cleanupTrips(db, [like]);
}
