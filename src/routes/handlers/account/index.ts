/**
 * GET    /api/account — 刪除前的影響預覽（確認對話框要用）
 * DELETE /api/account — 刪除自己的帳號
 *
 * Google Play 對「可建立帳號的 app」**強制要求**帳號刪除路徑，且要求 app 內與網頁
 * 各有一條。這支是兩條路徑共用的後端。
 *
 * Auth: requireAccountUser（user-bound bearer）
 *
 * Body: { password: string } — 帳號有 local 密碼身分時**必須**帶，做二次確認。
 *   沒有密碼的帳號沒有任何可用的重新驗證方式（Google 重新驗證已移除，trip-planner#1643），
 *   **fail-closed**：一律 403 ACCOUNT_DELETE_REAUTH_REQUIRED，不接受 confirm、challengeId 或任何 client 自報的證明。
 *
 * Response 200: { ok: true, tripsDeleted, auditRowsAnonymized, tablesCleared }
 *   token／授權／殘留的舊 challenge 在同一個 D1 batch 內清除（eraseUserAccount）；抹除失敗整批回滾，帳號完整。
 *
 * ⚠ 這是**不可逆**操作。二次確認不是形式：owner 決策為「擁有的行程一併刪除，
 *   含共編者的」，誤觸的代價是別人的資料也沒了。
 *
 * ⚠ 實際抹除邏輯在 `_erasure.ts`（逐表顯式刪除，不依賴 CASCADE）。
 *   本檔只負責驗證與回應，不重複實作刪除順序。
 */
import { requireAccountUser } from '../../../lib/account-user';
import { AppError } from '../../../errors';
import { rawJson } from '../../../lib/utils';
import { verifyPassword } from '../../../lib/password';
import { eraseUserAccount } from '../../../lib/erasure';
import type { Env } from '../../../env';

interface DeleteAccountBody {
  password?: unknown;
}

/** 該帳號的 local 密碼 hash（沒有則 null）。GET 與 DELETE 共用，避免兩處判斷漂移。 */
async function findLocalPasswordHash(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB
    .prepare(
      `SELECT password_hash FROM auth_identities
        WHERE user_id = ? AND provider = 'local' AND password_hash IS NOT NULL`,
    )
    .bind(userId)
    .first<{ password_hash: string }>();
  return row?.password_hash ?? null;
}

/**
 * GET /api/account — 刪除影響預覽。
 *
 * 確認對話框必須誠實顯示「按下去會發生什麼」。owner 決策是**行程一併刪除，含共編者的**，
 * 所以受影響的共編人數一定要先讓使用者看到 —— 這個數字前端算不出來，只能後端查。
 *
 * Response: { hasPassword, reauthProvider, reauthenticated, tripsOwned, collaboratorsAffected }
 *   - reauthProvider／reauthenticated：已棄用的相容欄位（舊 web 的型別檢查仍要求它們存在），恆為 null／false
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const userId = session.uid;

  const hasPassword = (await findLocalPasswordHash(context.env, userId)) !== null;

  const owned = await context.env.DB
    .prepare('SELECT count(*) AS n FROM trips WHERE owner_user_id = ?')
    .bind(userId)
    .first<{ n: number }>();

  // 受影響的共編者 = 這些行程上「不是自己」的 distinct user。
  // DISTINCT 是必要的：同一人可能出現在多個行程，不能重複計數。
  const collab = await context.env.DB
    .prepare(
      `SELECT count(DISTINCT tp.user_id) AS n
         FROM trip_permissions tp
         JOIN trips t ON t.id = tp.trip_id
        WHERE t.owner_user_id = ? AND tp.user_id != ?`,
    )
    .bind(userId, userId)
    .first<{ n: number }>();

  return rawJson({
    hasPassword,
    reauthProvider: null,
    reauthenticated: false,
    tripsOwned: owned?.n ?? 0,
    collaboratorsAffected: collab?.n ?? 0,
  });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const actor = await requireAccountUser(context);
  const userId = actor.uid;

  let body: DeleteAccountBody = {};
  try {
    body = (await context.request.json()) as DeleteAccountBody;
  } catch {
    // 空 body / 非 JSON —— 當作沒帶確認，交給下方統一擋。
  }

  const passwordHash = await findLocalPasswordHash(context.env, userId);
  // fail-closed：沒有密碼就沒有任何可用的重新驗證方式，不得退回「免驗證可刪」。
  if (!passwordHash) throw new AppError('ACCOUNT_DELETE_REAUTH_REQUIRED');

  // 有密碼 → 必須用密碼確認。這是不可逆操作，不接受只按按鈕。
  if (typeof body.password !== 'string' || body.password.length === 0) {
    throw new AppError('ACCOUNT_DELETE_CONFIRM_REQUIRED', '請輸入密碼以確認刪除');
  }
  // ⚠ 密碼錯時**不得**動到任何資料 —— 在呼叫 eraseUserAccount 之前就返回。
  if (!(await verifyPassword(body.password, passwordHash))) throw new AppError('ACCOUNT_DELETE_PASSWORD_INVALID');

  // 失敗時 D1 batch 整批回滾、帳號仍完整，錯誤直接往上拋。
  const summary = await eraseUserAccount(context.env.DB, userId);

  return rawJson({
    ok: true,
    tripsDeleted: summary.tripsDeleted,
    auditRowsAnonymized: summary.auditRowsAnonymized,
    tablesCleared: summary.tablesCleared,
  });
};
