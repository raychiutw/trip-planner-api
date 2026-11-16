/**
 * 批准決策（純函式，不經資料庫）：授權請求 + 批准者 → 判別式結果。
 * handler 負責取資料（含環境閘門、client 重驗）、呼叫這裡、組回應與稽核。
 *
 * 規則：
 * - deny：一律 deny，不帶旗標。
 * - approve：旗標只由 server 決定，必須是白名單值且設定者就是批准者。
 * 重新驗證模式（prompt=login、expected_account、disable 意圖）已移除（ADR-0019），舊參數一律忽略。
 */
import { isBiometricIntent, type BiometricIntent } from '../oauth-contract';
import type { AuthRequestPayload } from '../auth-request';

export type ApprovalDecision =
  | { kind: 'deny' }
  | { kind: 'approve'; biometricIntent: BiometricIntent | undefined };

export function decideApproval(input: { decision: 'approve' | 'deny'; req: AuthRequestPayload; userId: string }): ApprovalDecision {
  const { decision, req, userId } = input;
  if (decision === 'deny') return { kind: 'deny' };
  return {
    kind: 'approve',
    biometricIntent: isBiometricIntent(req.intent) && req.intent_user_id === userId ? req.intent : undefined,
  };
}
