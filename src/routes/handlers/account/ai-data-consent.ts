/**
 * /api/account/ai-data-consent — AI 資料同意（spec #1553、ADR-0012）。
 *
 * 與 /api/account/ai-authorization（AI 操作授權：owner 讓 AI 以自己身分改自己的行程）是兩個獨立概念，互不取代。
 *
 * GET    → 狀態（none／valid／stale／withdrawn）、目前版本、已接受版本與時間、目前版本的說明文字、enforced
 * POST   { version } → 同意「使用者實際看到的版本」；未知或與目前版本不符 → 409 AI_CONSENT_VERSION_MISMATCH（不寫入）；
 *                       冪等。只寫呼叫者自己，不吃 body 裡的 userId／client。
 * DELETE → 撤回（冪等）。撤回後新請求立即被拒絕；排隊中尚未開始的請求被終結（ADR-0007，已開始的不保證能停）。
 *
 * 旗標不影響這三個動作，旗標只決定三個受管制入口檢不檢查。文案未填妥時 POST 回 409 AI_CONSENT_NOT_READY（GET／DELETE 照常）。
 * Auth: requireAccountUser（第一方 client 的 user-bound bearer）。
 */
import { requireAccountUser } from '../../../lib/account-user';
import { AppError } from '../../../errors';
import { parseJsonBody, rawJson } from '../../../lib/utils';
import { updateRequest } from '../../../lib/request-termination';
import { currentConsentText, getConsentState, isConsentTextComplete, recordAccepted, recordWithdrawn } from '../../../lib/ai-data-consent';
import { CURRENT_CONSENT_VERSION } from '../../../lib/ai-data-consent-text';
import type { Env } from '../../../env';

async function stateResponse(env: Env, userId: string): Promise<Response> {
  const state = await getConsentState(env.DB, userId);
  return rawJson({ ...state, text: currentConsentText(), enforced: true /* 舊版 client 相容：一律強制 */ });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { uid } = await requireAccountUser(context);
  return stateResponse(context.env, uid);
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { uid } = await requireAccountUser(context);
  const body = await parseJsonBody<{ version?: unknown }>(context.request);
  if (typeof body?.version !== 'string' || !body.version) throw new AppError('DATA_VALIDATION', '缺少 version');
  if (body.version !== CURRENT_CONSENT_VERSION) {
    throw new AppError('AI_CONSENT_VERSION_MISMATCH', `目前版本是 ${CURRENT_CONSENT_VERSION}`, { currentVersion: CURRENT_CONSENT_VERSION });
  }
  // 文案還有待填占位符時不得記錄同意（使用者不能對一份未完成的說明按「同意」）
  if (!isConsentTextComplete()) {
    throw new AppError('AI_CONSENT_NOT_READY', '說明文字尚未完成', { currentVersion: CURRENT_CONSENT_VERSION });
  }
  await recordAccepted(context.env.DB, uid);
  return stateResponse(context.env, uid);
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { uid, email } = await requireAccountUser(context);
  const wrote = await recordWithdrawn(context.env.DB, uid);
  // 已是 withdrawn（重試）也再清一次：先前清理若中途失敗（500），重試時 wrote=false 不能讓排隊請求永遠留著（冪等：只動 open）。
  if (wrote || (await getConsentState(context.env.DB, uid)).status === 'withdrawn') await terminateQueuedRequests(context.env.DB, uid, email);
  return stateResponse(context.env, uid);
};

/** 寫回 chat 的說明：這些請求從未開始，不是「停止等待」（預設的 cancelled 文案會讓人以為 AI 可能已動過行程）。 */
const WITHDRAWN_REPLY = 'AI 資料同意已撤回，這個請求沒有被處理。';

/**
 * 終結「排隊中尚未開始」（status=open）的請求：本人送出的，以及本人擁有的行程上別人送出的
 * （owner 撤回後，旅伴的請求也不該再被處理）。processing 的不動——已開始的工作不保證能停。
 */
async function terminateQueuedRequests(db: D1Database, userId: string, email: string): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT * FROM trip_requests
       WHERE status = 'open'
         AND (submitted_by = ? OR trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?))`,
    )
    .bind(email, userId)
    .all<Record<string, unknown>>();
  for (const row of results ?? []) {
    try {
      await updateRequest(db, row, { status: 'failed', terminalReason: 'cancelled', reply: WITHDRAWN_REPLY }, { changedBy: 'system:ai-consent-withdrawn', onlyIfActive: true });
    } catch (err) {
      // 單筆失敗不能讓後面的請求留著不終結；已寫入 withdrawn，重試 DELETE 不會再清理
      console.error('[ai-data-consent] terminate queued request failed:', err);
    }
  }
}
