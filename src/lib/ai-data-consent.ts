/**
 * AI 資料同意（spec #1553、ADR-0012）：單一共用模組。三個受管制入口與三個同意動作都只呼叫這裡，
 * 不各自複製「版本有效」的判斷。
 *
 * 同意狀態由「該使用者最新一筆事件」推導（事件只追加）：
 *   none      沒有任何事件
 *   valid     最新是 accepted，且版本＝目前版本
 *   stale     最新是 accepted，但版本≠目前版本（說明有實質變更，需重新同意）
 *   withdrawn 最新是 withdrawn
 *
 * 是否強制＝旗標 AI_CONSENT_ENFORCED 為 true **且** 目前版本的文字已無待填占位符；任一不成立，入口行為與沒有此功能時完全相同。
 */
import { AppError } from '../errors';
import type { AuthData, Env } from '../env';
import { CONSENT_TEXTS, CURRENT_CONSENT_VERSION, PLACEHOLDER_PATTERN, type ConsentText } from './ai-data-consent-text';

export type ConsentStatus = 'none' | 'valid' | 'stale' | 'withdrawn';

export interface ConsentState {
  status: ConsentStatus;
  currentVersion: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}

export const currentConsentText = (): ConsentText => CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!;

/** 文字裡只要還有任何待填占位符就是未完成。 */
export function isConsentTextComplete(text: ConsentText = currentConsentText()): boolean {
  return !PLACEHOLDER_PATTERN.test(JSON.stringify(text));
}

/** 旗標值只認 'true'（其餘一律視為關閉）。 */
export function isConsentEnforced(env: Pick<Env, 'AI_CONSENT_ENFORCED'>): boolean {
  return env.AI_CONSENT_ENFORCED === 'true' && isConsentTextComplete();
}

interface EventRow { event: string; version: string; created_at: string }

export async function getConsentState(db: D1Database, userId: string): Promise<ConsentState> {
  const latest = await db
    .prepare('SELECT event, version, created_at FROM ai_data_consent_events WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .bind(userId)
    .first<EventRow>();
  const base = { currentVersion: CURRENT_CONSENT_VERSION, acceptedVersion: null, acceptedAt: null };
  if (!latest) return { status: 'none', ...base };
  if (latest.event === 'withdrawn') return { status: 'withdrawn', ...base };
  return {
    status: latest.version === CURRENT_CONSENT_VERSION ? 'valid' : 'stale',
    currentVersion: CURRENT_CONSENT_VERSION,
    acceptedVersion: latest.version,
    acceptedAt: latest.created_at,
  };
}

/** 接受目前版本。最新事件已是「同版 accepted」就不再新增（單一語句內判斷，重複與並行提交都冪等）。 */
export async function recordAccepted(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_data_consent_events (user_id, version, event)
       SELECT ?, ?, 'accepted'
       WHERE NOT EXISTS (
         SELECT 1 FROM ai_data_consent_events
         WHERE user_id = ? AND event = 'accepted' AND version = ?
           AND id = (SELECT MAX(id) FROM ai_data_consent_events WHERE user_id = ?)
       )`,
    )
    .bind(userId, CURRENT_CONSENT_VERSION, userId, CURRENT_CONSENT_VERSION, userId)
    .run();
}

/** 撤回：只有「最新事件是 accepted」才追加 withdrawn（沒同意過或已撤回＝冪等，不寫）。回傳是否真的寫入。 */
export async function recordWithdrawn(db: D1Database, userId: string): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO ai_data_consent_events (user_id, version, event)
       SELECT user_id, version, 'withdrawn' FROM ai_data_consent_events
       WHERE user_id = ? AND event = 'accepted'
         AND id = (SELECT MAX(id) FROM ai_data_consent_events WHERE user_id = ?)`,
    )
    .bind(userId, userId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * 受管制入口的閘門（雙方同意）：送出者與行程 owner 都必須是 valid。
 * 必須在「已確認有該行程寫權限」之後、任何寫入之前呼叫。
 * 不是 user-bound 的 token（服務 token、無 userId）不套用——那是系統排程，不是某位使用者的資料交付。
 */
export async function assertAiConsent(env: Pick<Env, 'DB' | 'AI_CONSENT_ENFORCED'>, auth: AuthData, tripId: string): Promise<void> {
  if (!isConsentEnforced(env)) return;
  if (auth.isServiceToken || !auth.userId) return;

  const sender = await getConsentState(env.DB, auth.userId);
  if (sender.status !== 'valid') throw consentError('AI_CONSENT_REQUIRED', sender);

  const trip = await env.DB.prepare('SELECT owner_user_id FROM trips WHERE id = ?').bind(tripId).first<{ owner_user_id: string | null }>();
  const ownerId = trip?.owner_user_id;
  if (!ownerId || ownerId === auth.userId) return; // owner 自己送：同一人，只檢查一次
  const owner = await getConsentState(env.DB, ownerId);
  if (owner.status !== 'valid') throw consentError('AI_CONSENT_OWNER_REQUIRED', owner);
}

function consentError(code: 'AI_CONSENT_REQUIRED' | 'AI_CONSENT_OWNER_REQUIRED', state: ConsentState): AppError {
  const who = code === 'AI_CONSENT_REQUIRED' ? '你尚未同意' : '行程擁有者尚未同意';
  return new AppError(code, `${who} AI 資料處理（需要版本 ${CURRENT_CONSENT_VERSION}）`, {
    requiredVersion: CURRENT_CONSENT_VERSION,
    status: state.status,
  });
}
