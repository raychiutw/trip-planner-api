/**
 * GET    /api/account — 刪除前的影響預覽（確認對話框要用）
 * DELETE /api/account — 刪除自己的帳號
 *
 * Google Play 對「可建立帳號的 app」**強制要求**帳號刪除路徑，且要求 app 內與網頁
 * 各有一條。這支是兩條路徑共用的後端。
 *
 * Auth: requireAccountUser（user-bound bearer）
 *
 * Body（擇一）:
 *   { password: string }  — 帳號有 local 密碼身分時**必須**帶，做二次確認
 *   { confirm: 'DELETE', challengeId: string } — 無密碼帳號（mobile）：確認字串之外，還要先完成同帳號的近期 Google 重新驗證
 *   { challengeId: string } — 無密碼帳號（web，tripline-web）：不需要 confirm，Google 重新驗證本身就是確認；web 帶 confirm 也接受
 *     （POST /api/account/delete-reauth 建立 challenge → 使用者在 Google 驗證 → challenge 變 verified）。
 *     **fail-closed**：只帶 confirm、沒有 verified challenge → 403 ACCOUNT_DELETE_REAUTH_REQUIRED。
 *     challenge 必須與呼叫者同 surface（mobile／web 不可互用）；其他 client 的無密碼帳號一律走不通。
 *
 * Response 200: { ok: true, tripsDeleted, auditRowsAnonymized, tablesCleared }
 *   token／授權／challenge 在同一個 D1 batch 內清除（eraseUserAccount）；抹除失敗整批回滾，
 *   challenge 由 used 還原為 verified，可在有效期內重試。
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
import { hasVerifiedChallenge, readMobileDeleteChallenge, resolveAccountSurface, transitionMobileDeleteChallenge } from '../../../lib/delete-reauth';
import type { Env } from '../../../env';

interface DeleteAccountBody {
  password?: unknown;
  confirm?: unknown;
  challengeId?: unknown;
}

/** 純 OAuth 帳號的確認字串（另需近期 Google 重新驗證，只打這個不夠）。刻意用英文大寫，避免輸入法誤觸。 */
const CONFIRM_PHRASE = 'DELETE';

/**
 * 該帳號有沒有 local 密碼身分 —— 決定二次確認要用密碼還是確認字串。
 * GET 與 DELETE 共用，避免兩處判斷漂移。
 */
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
 *   - reauthProvider：無密碼帳號可用的重新驗證 provider（目前只有 'google'）；有密碼或沒有 Google 身分時為 null
 *   - reauthenticated：web 呼叫者＝本 grant 有 verified、未過期、未使用的 web challenge；mobile 恆為 false（證明在 challenge 狀態查詢）
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const userId = session.uid;

  const hasPassword = (await findLocalPasswordHash(context.env, userId)) !== null;
  const googleIdentity = hasPassword ? null : await context.env.DB
    .prepare("SELECT 1 FROM auth_identities WHERE user_id = ? AND provider = 'google'").bind(userId).first();

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

  // web 呼叫者：本 grant 有 verified、未過期、未使用的 web challenge 才算已重新驗證；mobile 維持 false（證明由 challenge 狀態查詢）。
  const surface = hasPassword ? null : resolveAccountSurface(session.auth, context.env, context.request);
  const reauthenticated = surface === 'web' &&
    await hasVerifiedChallenge(context.env.DB, { uid: userId, grantId: session.auth.grantId!, clientId: session.auth.clientId!, surface });

  return rawJson({
    hasPassword,
    reauthProvider: googleIdentity ? 'google' : null,
    reauthenticated,
    tripsOwned: owned?.n ?? 0,
    collaboratorsAffected: collab?.n ?? 0,
  });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const actor = await requireAccountUser(context);
  const userId = actor.uid;
  const grant = { grantId: actor.auth.grantId, clientId: actor.auth.clientId };

  let body: DeleteAccountBody = {};
  try {
    body = (await context.request.json()) as DeleteAccountBody;
  } catch {
    // 空 body / 非 JSON —— 當作沒帶確認，交給下方統一擋。
  }

  // 這個帳號有沒有 local 密碼身分？決定二次確認要用哪種方式。
  const passwordHash = await findLocalPasswordHash(context.env, userId);

  if (passwordHash) {
    // 有密碼 → 必須用密碼確認。這是不可逆操作，不接受只按按鈕。
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new AppError('ACCOUNT_DELETE_CONFIRM_REQUIRED', '請輸入密碼以確認刪除');
    }
    const ok = await verifyPassword(body.password, passwordHash);
    if (!ok) {
      // ⚠ 密碼錯時**不得**動到任何資料 —— 在呼叫 eraseUserAccount 之前就返回。
      throw new AppError('ACCOUNT_DELETE_PASSWORD_INVALID');
    }
  } else {
    // 呼叫面：mobile 要確認字串；web 的確認就是使用者在 Google 的重新驗證，不要求 confirm。其他 client 一律 fail-closed。
    const surface = resolveAccountSurface(actor.auth, context.env, context.request);
    // web 帶了 challengeId 就不要求 confirm；什麼都沒帶（沒有 confirm 也沒有 challengeId）仍回 400，維持原本的提示。
    if (body.confirm !== CONFIRM_PHRASE && !(surface === 'web' && typeof body.challengeId === 'string')) {
      throw new AppError(
        'ACCOUNT_DELETE_CONFIRM_REQUIRED',
        `請輸入 ${CONFIRM_PHRASE} 以確認刪除`,
      );
    }
    // fail-closed：沒有 verified、同帳號、同 grant、同 client、同 surface 的 challenge 就不放行。
    const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
    const challenge = surface && challengeId ? await readMobileDeleteChallenge(context.env.DB, challengeId) : null;
    if (!surface || !challenge || !grant.grantId || challenge.surface !== surface ||
        challenge.uid !== userId || challenge.grantId !== grant.grantId ||
        challenge.clientId !== grant.clientId || challenge.expired ||
        !(await transitionMobileDeleteChallenge(context.env.DB, challengeId, userId, grant.grantId, 'verified', 'used'))) {
      throw new AppError('ACCOUNT_DELETE_REAUTH_REQUIRED');
    }
  }

  let summary;
  try {
    summary = await eraseUserAccount(context.env.DB, userId);
  } catch (error) {
    // D1 batch 已整批回滾，帳號仍完整；還原同一份 fresh-auth 證明，使用者可在有效期內重試。
    if (!passwordHash && grant.grantId && typeof body.challengeId === 'string') {
      await transitionMobileDeleteChallenge(context.env.DB, body.challengeId, userId, grant.grantId, 'used', 'verified');
    }
    throw error;
  }

  return rawJson({
    ok: true,
    tripsDeleted: summary.tripsDeleted,
    auditRowsAnonymized: summary.auditRowsAnonymized,
    tablesCleared: summary.tablesCleared,
  });
};
