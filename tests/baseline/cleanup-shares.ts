import { cleanupTrips } from './cleanup-trips';

/**
 * 共用 D1 下，清掉分享／邀請測試（專屬前綴 `s15-`）建立的所有資料：
 * 以前綴命名的行程、以前綴 email 的使用者擁有的行程（含 clone 出來的 `cln-` 行程）、
 * 以及它們的分享連結、邀請、筆記區塊、稽核紀錄、限流桶與 session。
 * 開頭與結尾都呼叫即可（冪等），避免前次失敗殘留。
 */
export async function cleanupS15(db: D1Database, ips: string[] = []): Promise<void> {
  const userLike = 'test-user-s15-%';
  // 行程數上限測試會批次塞入大量只有 trips 列的行程，先整批刪掉，避免逐筆清理太慢
  await db.prepare('DELETE FROM trips WHERE id LIKE ?').bind('s15-cap-%').run();
  const owned = await db
    .prepare('SELECT id FROM trips WHERE id LIKE ? OR owner_user_id LIKE ?')
    .bind('s15-%', userLike)
    .all<{ id: string }>();
  const ids = owned.results.map((r) => r.id);
  for (const id of ids) {
    for (const table of [
      'trip_shares', 'trip_invitations', 'trip_destinations', 'trip_pretrip_notes', 'trip_flights',
      'trip_lodgings', 'trip_reservations', 'trip_emergency_contacts', 'audit_log',
    ]) {
      await db.prepare(`DELETE FROM ${table} WHERE trip_id = ?`).bind(id).run();
    }
  }
  await cleanupTrips(db, ids, ['s15-%']);
  // 沒掛在行程上的資料（行程已被測試刪掉或本來就不存在）
  await db.prepare('DELETE FROM trip_invitations WHERE invited_email LIKE ?').bind('s15-%').run();
  await db.prepare('DELETE FROM audit_log WHERE changed_by LIKE ?').bind('s15-%').run();
  await db.prepare('DELETE FROM session_devices WHERE user_id LIKE ?').bind(userLike).run();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`clone:user:${userLike}`).run();
  for (const ip of ips) {
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${ip}`).run();
  }
  await db.prepare('DELETE FROM users WHERE id LIKE ?').bind(userLike).run();
}
