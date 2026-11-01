/**
 * 安全事件的稽核與告警（T11）。
 *
 * 五類：auth_failure（無效／格式錯誤的憑證）、permission_denied、token_replay（code／refresh／DPoP jti 重放）、
 * signature_error（DPoP 簽章或欄位無效）、rate_limited（登入被鎖）。
 * 全部寫 auth_audit_log（failure）；高嚴重度的（token_replay、signature_error、rate_limited）另走既有的 Telegram 通知管道。
 *
 * 防濫用：
 * - 稽核寫入每個 IP × 事件類型每分鐘最多 30 筆（攻擊者不能把這裡當寫入放大器；超過的只被擋、不寫）。
 * - 告警每個事件類型 10 分鐘最多一則（分散式攻擊也只會響一次）。
 * 隱私：只記錄方法、路徑（不含 query）、原因代碼、client／user id；絕不記錄 token、密碼、code、email、body、原始 IP。
 * 這個函式永遠不丟例外：稽核或告警失敗不能影響原本的回應。
 */
import type { Env } from '../env';
import { alertAdminTelegram } from './alert';
import { recordAuthEvent, type AuthEventType } from './auth-audit';
import { bumpRateLimit, clientIp } from './rate-limit';

export type SecurityEventKind = Extract<AuthEventType, 'auth_failure' | 'permission_denied' | 'token_replay' | 'signature_error' | 'rate_limited'>;

const ALERTED: ReadonlySet<SecurityEventKind> = new Set(['token_replay', 'signature_error', 'rate_limited']);
const WRITE_LIMIT = { maxAttempts: 30, windowMs: 60_000, lockoutMs: 60_000 };
const ALERT_LIMIT = { maxAttempts: 1, windowMs: 10 * 60_000, lockoutMs: 10 * 60_000 };

export interface SecurityEvent {
  kind: SecurityEventKind;
  /** 原因代碼（固定字串，不含使用者輸入）。 */
  reason: string;
  userId?: string | null;
  clientId?: string | null;
}

/** DPoP 驗證失敗的原因 → 事件類型：重放算 token_replay，其餘算 signature_error。 */
export function classifyDpopFailure(reason: string): Pick<SecurityEvent, 'kind' | 'reason'> {
  return reason === 'replay' ? { kind: 'token_replay', reason: 'dpop_jti_replay' } : { kind: 'signature_error', reason };
}

/** 只送告警（不寫稽核）：呼叫端已經自己寫過稽核時用（例如 token 重放的既有稽核列）。 */
export async function alertSecurityEvent(env: Env, request: Request, ev: SecurityEvent): Promise<void> {
  try {
    if (!ALERTED.has(ev.kind)) return;
    const gate = await bumpRateLimit(env.DB, `secalert:${ev.kind}`, ALERT_LIMIT);
    if (!gate.ok) return; // 10 分鐘內已經告警過
    const path = new URL(request.url).pathname;
    await alertAdminTelegram(env, `安全事件 ${ev.kind}：${ev.reason}（client=${ev.clientId ?? '-'}，${request.method} ${path}）`);
  } catch {
    /* 告警失敗不影響回應 */
  }
}

export async function recordSecurityEvent(env: Env, request: Request, ev: SecurityEvent): Promise<void> {
  try {
    const gate = await bumpRateLimit(env.DB, `secevt:${ev.kind}:${clientIp(request)}`, WRITE_LIMIT);
    if (gate.ok) {
      await recordAuthEvent(env.DB, request, {
        eventType: ev.kind,
        outcome: 'failure',
        userId: ev.userId ?? null,
        clientId: ev.clientId ?? null,
        failureReason: ev.reason,
        metadata: { method: request.method, path: new URL(request.url).pathname },
      }, env);
    }
  } catch {
    /* 稽核失敗不影響回應 */
  }
  await alertSecurityEvent(env, request, ev);
}
