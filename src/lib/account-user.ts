/**
 * 帳號類端點（account／dev/apps／invitations accept）的「本人」守衛。
 *
 * 舊入口用 cookie session（requireSessionUser）：只有登入過的人類使用者本人才有。
 * 新 api 只有 bearer，所以改成以下條件全部成立才放行，否則一律 AUTH_REQUIRED／PERM_DENIED：
 *   1. 有 user-bound token（service token／client_credentials 沒有 user_id → 401）。
 *   2. 不是 trip-scoped 受限 token（自家 AI 的 downscope token 不得碰帳號層級操作）。
 *   3. token 所屬的 client 不得是「已註冊且非第一方」的 client。
 *      舊 cookie session 等於「本人在自家 web」，第三方 OAuth app 拿到的 token
 *      （即使只有 openid/profile）不應能刪帳號、撤銷別人授權或發 AI 授權。
 *      token 只會由已註冊的 client 簽發，所以「查不到 client 列」只會出現在測試／已刪除的 client，
 *      此時放行（維持原本以 token 為準的行為）；已刪除的 client 其 token 仍屬使用者本人簽發。
 */
import { AppError } from '../errors';
import type { AuthData, Env } from '../env';
import { requireAuth, assertNotTripRestricted } from './permissions';

export interface AccountUser {
  uid: string;
  email: string;
  auth: AuthData;
}

export async function requireAccountUser(context: { data: unknown; env: Env }): Promise<AccountUser> {
  const auth = requireAuth(context);
  if (auth.isServiceToken || !auth.userId) throw new AppError('AUTH_REQUIRED');
  assertNotTripRestricted(auth);
  if (auth.clientId) {
    const client = await context.env.DB
      .prepare('SELECT first_party FROM client_apps WHERE client_id = ?')
      .bind(auth.clientId)
      .first<{ first_party: number }>();
    if (client && client.first_party !== 1) {
      throw new AppError('PERM_DENIED', '此操作僅限第一方應用程式');
    }
  }
  return { uid: auth.userId, email: auth.email, auth };
}
