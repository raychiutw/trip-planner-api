/**
 * 帳號刪除（erasure routine）
 *
 * Google Play 對「可建立帳號的 app」**強制要求**帳號刪除路徑。
 *
 * Owner 決策（2026-07-20）：
 *   - 擁有的行程 → **一併刪除**（含共編者的）
 *   - `audit_log` → **匿名化保留列**（洗掉個資，保留行為紀錄供稽核）
 *
 * ⚠ 為什麼逐表顯式刪除、不靠 CASCADE：
 *   ① live schema 有 6 張表帶 `trip_id` 卻**無** trips 外鍵
 *      （audit_log / error_reports / permissions / requests / trip_requests / trip_permissions）
 *      → 刪 trip 會留孤兒列
 *   ② 有 14 張表存了使用者身分卻**無** users 外鍵 → 刪 user 完全不連動
 *      最嚴重的是 `session_devices`（刪帳號後 session 還在）與 `audit_log.changed_by`（明文 email 永久留存）
 *   ③ 不依賴 D1 的 FK 強制設定，順序自己控、可測
 *
 * ⚠ 刪除順序有意義：`trips.owner_user_id` 是 `ON DELETE RESTRICT`，
 *    不先把行程處理掉，最後的 `DELETE FROM users` 會失敗。
 */

/** 匿名化後 `audit_log.changed_by` 的前綴。刻意保留可辨識的形狀供稽核追溯同一主體。 */
export const ERASURE_ANON_PREFIX = 'deleted-user-';

export interface ErasureSummary {
  /** users.id 是 **TEXT** PK（非 autoincrement integer），型別不可寫成 number。 */
  userId: string;
  /** 實際刪掉的行程數（該使用者為 owner 的） */
  tripsDeleted: number;
  /** audit_log 被匿名化的列數 */
  auditRowsAnonymized: number;
  /** 每張表實際影響的列數，供 audit 與問題排查 */
  tablesCleared: Record<string, number>;
}

/**
 * 隨行程刪除的子表。live schema 上這些**有** trips 外鍵（CASCADE），
 * 但我們仍顯式刪 —— 見檔頭③。
 */
const TRIP_CHILD_TABLES = [
  'trip_days', 'trip_destinations', 'trip_emergency_contacts',
  'trip_flights', 'trip_health_reports', 'trip_invitations', 'trip_lodgings',
  'trip_note_ai_exclusions', 'trip_note_ai_jobs', 'trip_pois', 'trip_pretrip_notes', 'trip_reservations',
  'trip_segments', 'trip_shares',
] as const;

/**
 * 有 `trip_id` 但**無** trips 外鍵的表 —— 刪行程時不會連動，必須顯式清。
 * `audit_log` 不在此列：它走匿名化不走刪除（owner 決策）。
 */
const TRIP_ORPHAN_TABLES = [
  'error_reports', 'permissions', 'requests', 'trip_requests', 'trip_permissions',
] as const;

/**
 * 有 `user_id` 但**無** users 外鍵的表 —— 刪使用者時不會連動。
 * `auth_audit_log` 保留在此：它雖有 30 天保留期，但刪帳號時就該清掉可識別列。
 */
const USER_ORPHAN_TABLES = [
  'session_devices', 'auth_audit_log',
] as const;

/** 安全地跑一句 DDL/DML；表不存在時回 0 而不是炸掉（不同環境 schema 版本可能落差）。 */
async function runCounted(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const res = await db.prepare(sql).bind(...binds).run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    // 表不存在是可接受的（migration 版本落差）；其他錯誤要往上拋，不可靜默吞掉。
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) return 0;
    throw err;
  }
}

/**
 * 抹除一個使用者的所有可識別資料。
 *
 * 冪等：對不存在的 userId 呼叫不會拋錯，回傳全 0 的摘要。
 *
 * ⚠ 這不是 transaction。D1 沒有跨 statement 的互動式交易，中途失敗會留下半刪狀態。
 *   順序刻意由「最外圍的衍生資料」往「users 本體」收，所以中斷時殘留的是
 *   孤兒資料而不是「使用者已刪但個資還在」—— 後者才是合規風險。
 *   重跑本函式可收斂剩餘部分。
 */
export async function eraseUserAccount(db: D1Database, userId: string): Promise<ErasureSummary> {
  const tablesCleared: Record<string, number> = {};
  const bump = (t: string, n: number) => { if (n > 0) tablesCleared[t] = (tablesCleared[t] ?? 0) + n; };

  // ── 1. 找出該使用者擁有的行程 ──────────────────────────────
  const owned = await db
    .prepare('SELECT id FROM trips WHERE owner_user_id = ?')
    .bind(userId)
    .all<{ id: string }>();
  const tripIds = (owned.results ?? []).map((r) => r.id);

  // ── 2. 逐行程清子表 → 孤兒表 → 行程本身 ────────────────────
  for (const tripId of tripIds) {
    for (const t of TRIP_CHILD_TABLES) {
      bump(t, await runCounted(db, `DELETE FROM ${t} WHERE trip_id = ?`, tripId));
    }
    for (const t of TRIP_ORPHAN_TABLES) {
      bump(t, await runCounted(db, `DELETE FROM ${t} WHERE trip_id = ?`, tripId));
    }
    // trip_entries 掛在 trip_days 底下（無 trip_id 欄位），days 已刪則其 entries 亦無主。
    // 顯式清一次避免孤兒（子查詢在 days 已刪後為空集合，屬防禦性）。
    bump('trip_entries', await runCounted(
      db,
      `DELETE FROM trip_entries WHERE day_id IN (SELECT id FROM trip_days WHERE trip_id = ?)`,
      tripId,
    ));
    bump('trips', await runCounted(db, 'DELETE FROM trips WHERE id = ?', tripId));
  }

  // ── 3. audit_log 匿名化（保留列，洗掉個資）─────────────────
  // changed_by 是自由文字（實務上放 email），且 audit_log **不在** auth-cleanup.js
  // 的保留期清單內 → 不匿名化就等於永久留存明文 email。
  const anonId = `${ERASURE_ANON_PREFIX}${userId}`;
  const auditRowsAnonymized = await runCounted(
    db,
    `UPDATE audit_log
        SET changed_by = ?,
            changed_by_user_id = NULL,
            diff_json = NULL,
            snapshot = NULL
      WHERE changed_by_user_id = ?`,
    anonId,
    userId,
  );
  bump('audit_log(anonymized)', auditRowsAnonymized);

  // ── 4. 清掉無 users 外鍵的身分殘留 ─────────────────────────
  for (const t of USER_ORPHAN_TABLES) {
    bump(t, await runCounted(db, `DELETE FROM ${t} WHERE user_id = ?`, userId));
  }

  // 以 email 為鍵的殘留（rate_limit_buckets 用明文 email/IP 當 PK）。
  // 需先取得 email —— users 尚未刪除，此時仍讀得到。
  const user = await db
    .prepare('SELECT email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string }>();
  if (user?.email) {
    bump('rate_limit_buckets', await runCounted(
      db,
      `DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?`,
      `%:${user.email}`,
    ));
    // 該使用者送出的 AI 請求（submitted_by 存 email，無外鍵）
    for (const t of ['requests', 'trip_requests']) {
      bump(t, await runCounted(db, `DELETE FROM ${t} WHERE submitted_by = ?`, user.email));
    }
    // 由該使用者發出、尚未被接受的邀請（invited_email 是**第三方**個資，
    // 但邀請本身是本使用者的行為紀錄，一併清）
    bump('trip_invitations', await runCounted(
      db,
      `DELETE FROM trip_invitations WHERE invited_by = ?`,
      userId,
    ));
  }

  // ── 5. 最後刪 users 本體 ────────────────────────────────────
  // CASCADE 會帶走 auth_identities / poi_favorites / trip_health_reports / trip_permissions，
  // 但前面已顯式清過重疊部分，這裡是收尾。
  bump('users', await runCounted(db, 'DELETE FROM users WHERE id = ?', userId));

  return {
    userId,
    tripsDeleted: tripIds.length,
    auditRowsAnonymized,
    tablesCleared,
  };
}
