/**
 * 批准決策（純函式，不經資料庫）：授權請求 + 批准者 + 新鮮度結果 → 判別式結果。
 * handler 負責取資料（含環境閘門、client 重驗）、呼叫這裡、組回應與稽核。
 *
 * 規則（優先序由上而下）：
 * - deny：一律 deny，不受 reauth 限制，不帶旗標。
 * - 重新驗證模式（reauth_intent）與單獨 prompt=login 都要求剛用密碼登入，否則 reauth_required（請求保留，可重試）。
 * - 重新驗證模式的批准者必須是 expected_account，否則 account_mismatch（不發 code）；單獨 prompt=login 不比對帳號。
 * - 旗標只由 server 決定：reauth 模式用 reauth_intent；一般模式必須是白名單值且設定者就是批准者。
 */
import { PROMPT_LOGIN, isBiometricIntent, type BiometricIntent } from '../oauth-contract';
import type { AuthRequestPayload } from '../auth-request';

export type ApprovalDecision =
  | { kind: 'deny' }
  | { kind: 'reauth_required' }
  | { kind: 'account_mismatch' }
  | { kind: 'approve'; biometricIntent: BiometricIntent | undefined };

/** 批准這個請求是否要求「剛用密碼登入」。 */
export const requiresFreshLogin = (req: AuthRequestPayload): boolean => !!req.reauth_intent || req.prompt === PROMPT_LOGIN;

export function decideApproval(input: { decision: 'approve' | 'deny'; req: AuthRequestPayload; userId: string; freshLogin: boolean }): ApprovalDecision {
  const { decision, req, userId, freshLogin } = input;
  if (decision === 'deny') return { kind: 'deny' };
  if (requiresFreshLogin(req) && !freshLogin) return { kind: 'reauth_required' };
  if (req.reauth_intent && req.expected_account !== userId) return { kind: 'account_mismatch' };
  return {
    kind: 'approve',
    biometricIntent: req.reauth_intent
      ? req.reauth_intent
      : isBiometricIntent(req.intent) && req.intent_user_id === userId ? req.intent : undefined,
  };
}
