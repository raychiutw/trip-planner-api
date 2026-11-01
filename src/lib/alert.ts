/**
 * alertAdminTelegram — send admin notification via Telegram Bot API.
 *
 * Used for silent-fail recovery (email send failed, trigger fetch failed,
 * config missing, etc). Reuses the same TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 * (admin chat) as scripts/daily-check.
 *
 * Behaviour:
 * - env missing → console.warn + return（不 throw，避免影響 caller）
 * - fetch throw / non-2xx → console.error + return（fire-and-forget alert）
 * - 5s abort timeout
 *
 * Q10 decision: only Bearer auth on mailer endpoint, no IP ACL.
 * Q12 decision: no rate limit per IP.
 *
 * Defined in 2026-05-02-email-and-trigger-silent-fail-fix proposal.
 */

interface AlertEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export async function alertAdminTelegram(env: AlertEnv, message: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    // v2.33.134: 從 console.warn 提到 console.error — 之前 warn 在 wrangler tail
    // 預設 filter 掉，user forgot-password 530 alert 沒響但 log 看不到原因。
    console.error('[alert] SKIP — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set', {
      hasToken: !!token,
      hasChatId: !!chatId,
    });
    return;
  }
  // v2.33.134：log start + end 含 token prefix（前 10 chars）/ chat_id 末 4 / 訊息長度
  // → wrangler tail 可看到呼叫鏈，forensic forgot-password silent fail 用
  const tokenPrefix = token.slice(0, 10);
  const chatTail = chatId.slice(-4);
  const msgPreview = message.slice(0, 80);
  console.log('[alert] sending', {
    tokenPrefix,
    chatTail,
    msgPreview,
    msgLen: message.length,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚨 [Tripline] ${message}`,
      }),
      signal: ctrl.signal,
    });
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[alert] Telegram API non-2xx', {
        status: res.status,
        body: errText.slice(0, 200),
        elapsedMs,
        tokenPrefix,
        chatTail,
      });
      return;
    }
    console.log('[alert] sent OK', { status: res.status, elapsedMs });
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.error('[alert] Telegram fetch failed', {
      error: err instanceof Error ? err.message : String(err),
      elapsedMs,
      aborted: ctrl.signal.aborted,
      tokenPrefix,
      chatTail,
    });
  } finally {
    clearTimeout(timer);
  }
}
