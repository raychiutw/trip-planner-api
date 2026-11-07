import { alertAdminTelegram } from './alert';
import type { Env } from '../env';

/**
 * 外部心跳（trip-planner#1623）：agent 或整台 Mac 掛掉時，請求長時間無人處理要告警。
 * 由 Cron Trigger 呼叫（src/index.ts 的 scheduled）。
 *
 * - 停滯 = trip_requests 有 status IN ('open','processing')，且 COALESCE(updated_at, created_at)
 *   早於門檻。齡的算法與 reapIfStale（request-termination.ts）一致；收屍後 status 會變 failed，
 *   自然不再算停滯。門檻預設 30 分鐘（agent 側 checkStall 為 20 分鐘：它在 tick 內看、較早；
 *   這裡是 agent 本身掛掉時的外部兜底，刻意放寬以免與 agent 自己的告警重複；仍須小於 REQUEST_STALE_MINUTES）。
 * - 狀態變化才發：上次狀態存 app_settings，持續停滯不重複，恢復時發一則恢復通知。
 *   只在 Telegram 確認送出後才寫狀態；失敗則下次排程重試。
 * - Telegram 未設定 → 整個功能靜默（不查 D1、不寫狀態、不 log）。
 * - 訊息只含請求編號、數量與等待分鐘，不含 token／email／IP／使用者內容。
 */
const STATE_KEY = 'request_stall_alerted';
const DEFAULT_THRESHOLD_MINUTES = 30;

export async function checkRequestStall(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const parsed = Number.parseInt(env.REQUEST_STALL_THRESHOLD_MINUTES ?? '', 10);
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD_MINUTES;

  const stalled = await env.DB
    .prepare(
      `SELECT MIN(id) AS oldest_id, COUNT(*) AS n,
              CAST((julianday('now') - julianday(MIN(COALESCE(updated_at, created_at)))) * 1440 AS INTEGER) AS waited_min
         FROM trip_requests
        WHERE status IN ('open', 'processing')
          AND COALESCE(updated_at, created_at) <= datetime('now', ?)`,
    )
    .bind(`-${threshold} minutes`)
    .first<{ oldest_id: number | null; n: number; waited_min: number | null }>();

  const prev = await env.DB
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(STATE_KEY)
    .first<{ value: string }>();
  const wasAlerted = prev?.value === 'true';
  const isStalled = (stalled?.n ?? 0) > 0;
  if (isStalled === wasAlerted) return;

  const ok = isStalled
    ? await alertAdminTelegram(
      env,
      `請求停滯：${stalled!.n} 筆請求超過 ${threshold} 分鐘無人處理（最久 ${stalled!.waited_min} 分鐘，請求 #${stalled!.oldest_id}）→ agent 或 Mac 可能停擺。`,
      )
    : await alertAdminTelegram(env, '請求停滯已解除：待處理請求已回到門檻內或隊列已清空。');
  // 發送失敗不寫狀態：下次排程重試，避免最後兜底的告警靜默遺失。
  if (!ok) return;
  await env.DB
    .prepare(
      `INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, 'system:request-stall-heartbeat')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
    )
    .bind(STATE_KEY, isStalled ? 'true' : 'false')
    .run();
}
