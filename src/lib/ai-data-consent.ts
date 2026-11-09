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
 * 閘門永遠強制（2026-11-10 起連「文案未填妥就不強制」的保險也移除）：以行程擁有者的同意為準，旅伴自己不需同意。
 * 文字仍含占位符時使用者無法同意（POST 回 AI_CONSENT_NOT_READY），AI 入口會被擋，所以上線前必須先填妥。
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
 * 受管制入口的閘門：行程內容屬於 owner，所以要求 owner 有效的資料同意；旅伴（共編者）自己不需同意，
 * owner 同意後旅伴直接放行。owner 自己送出則檢查本人。
 * 必須在「已確認有該行程寫權限」之後、任何寫入之前呼叫。
 * 不是 user-bound 的 token（服務 token、無 userId）不套用——那是系統排程，不是某位使用者的資料交付。
 */
export async function assertAiConsent(env: Pick<Env, 'DB'>, auth: AuthData, tripId: string): Promise<void> {
  if (auth.isServiceToken || !auth.userId) return;

  const trip = await env.DB.prepare('SELECT owner_user_id FROM trips WHERE id = ?').bind(tripId).first<{ owner_user_id: string | null }>();
  const ownerId = trip?.owner_user_id ?? auth.userId; // 查不到擁有者：退回檢查送出者本人
  const state = await getConsentState(env.DB, ownerId);
  if (state.status === 'valid') return;
  throw consentError(ownerId === auth.userId ? 'AI_CONSENT_REQUIRED' : 'AI_CONSENT_OWNER_REQUIRED', state);
}

function consentError(code: 'AI_CONSENT_REQUIRED' | 'AI_CONSENT_OWNER_REQUIRED', state: ConsentState): AppError {
  const who = code === 'AI_CONSENT_REQUIRED' ? '你尚未同意' : '行程擁有者尚未同意';
  // owner 的狀態不揭露給旅伴（只需知道缺的是 owner）；送出者自己的狀態才帶 status
  return new AppError(code, `${who} AI 資料處理（需要版本 ${CURRENT_CONSENT_VERSION}）`, {
    requiredVersion: CURRENT_CONSENT_VERSION,
    ...(code === 'AI_CONSENT_REQUIRED' ? { status: state.status } : {}),
  });
}

/**
 * mint 時的檢查（ADR-0012 補強）：agent 取得 owner 權限 token 才是資料真正交付 AI 的時間點。
 * 只看擁有者：旅伴送出的要求不需要旅伴自己同意。回傳 'owner'＝擁有者缺同意，有效時回 null。
 */
export async function consentGapAtMint(env: Pick<Env, 'DB'>, ownerUserId: string): Promise<'owner' | null> {
  return (await getConsentState(env.DB, ownerUserId)).status === 'valid' ? null : 'owner';
}
