/**
 * 重新驗證（step-up）證明（ADR-0016，票 api#81）：已登入者用 passkey 或密碼再證明一次「是本人」，換一張短時效的不透明憑證，
 * 供敏感操作（#82）在執行前檢查。
 *
 * - 存在 oauth_models（name = StepUpProof），id 就是證明本身（32 bytes 隨機）；payload 帶 user_id 與 grant_id。
 * - 綁定「使用者」與「目前 session」：session 的識別沿用既有的 access token grantId（auth.grantId，與變更密碼、撤銷連線同一套）；
 *   同一個使用者在另一台裝置（不同 grant）拿到的證明不能互用，沒有 grantId 的舊格式 token 無法綁定，一律不發也不認。
 * - 5 分鐘內可重複使用（連續幾個敏感操作不必每次重驗）；過期由 D1Adapter 視為不存在。
 * shortcut: 證明不會因登出或換密碼而主動撤銷（最長 5 分鐘自然失效）；需要時在撤銷 grant 處一併 destroy。
 */
import { AppError } from '../errors';
import type { Env } from '../env';
import type { AccountUser } from './account-user';
import { generateOpaqueToken } from './crypto';
import { D1Adapter } from './oauth-d1-adapter';

export const STEP_UP_PROOF_MODEL = 'StepUpProof';
export const STEP_UP_PROOF_TTL_SECONDS = 5 * 60;
/** 敏感端點收證明用的請求標頭。 */
export const STEP_UP_PROOF_HEADER = 'X-Step-Up-Proof';

export type StepUpMethod = 'passkey' | 'password';

/** 目前 session 的識別；沒有就無法綁定，視為未登入。 */
export function requireGrantId(user: AccountUser): string {
  if (!user.auth.grantId) throw new AppError('AUTH_REQUIRED');
  return user.auth.grantId;
}

export async function issueStepUpProof(db: D1Database, user: AccountUser, method: StepUpMethod): Promise<string> {
  const proof = generateOpaqueToken(32);
  await new D1Adapter(db, STEP_UP_PROOF_MODEL).upsert(proof, { user_id: user.uid, grant_id: requireGrantId(user), method }, STEP_UP_PROOF_TTL_SECONDS);
  return proof;
}

/** 請求帶的證明是否有效：存在、未過期、屬於這個使用者、屬於目前這個 session。 */
export async function verifyStepUpProof(context: { request: Request; env: Env }, user: AccountUser): Promise<boolean> {
  const proof = context.request.headers.get(STEP_UP_PROOF_HEADER)?.trim();
  const grantId = user.auth.grantId;
  if (!proof || !grantId) return false;
  const row = await new D1Adapter(context.env.DB, STEP_UP_PROOF_MODEL).find(proof);
  return !!row && row.user_id === user.uid && row.grant_id === grantId;
}

/** 敏感端點用：沒有有效證明就丟 REAUTH_REQUIRED（403）。 */
export async function requireStepUpProof(context: { request: Request; env: Env }, user: AccountUser): Promise<void> {
  if (!(await verifyStepUpProof(context, user))) throw new AppError('REAUTH_REQUIRED');
}
