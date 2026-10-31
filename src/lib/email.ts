/**
 * Email service — sync send via mac mini Gmail SMTP over Tailscale Funnel.
 *
 * **Stack rewrite**（2026-05-02-email-and-trigger-silent-fail-fix）：
 * 從 Resend HTTP API 改成 fetch ${TRIPLINE_API_URL}/internal/mail/send
 * （mac mini scripts/tripline-api-server.ts），由 mac mini 用 nodemailer +
 * Gmail SMTP 寄出。
 *
 * 為何脫 Resend：
 *   1. trip-planner-dby.pages.dev 是 CF Pages 預設 domain，無法驗 DKIM；
 *      Resend 拒收。
 *   2. Vendor lock-in — 跟 OSM 整合決策一致，能脫離 vendor 就脫。
 *   3. mac mini 已是 always-on infrastructure，沿用同一條 funnel 就好。
 *
 * Behaviour:
 *   - sync await mac mini 寄完才回（user 點 → 等 1-3s → 看到結果）
 *   - 任何失敗（env 缺 / fetch 失敗 / mac mini 5xx）→ throw EmailError
 *   - 4 個 oauth/permissions endpoint catch EmailError → audit + telegram + 500
 *     誠實顯示「寄送失敗，請稍後再試」(Q7 全 endpoint 不豁免)
 *
 * Required env：
 *   TRIPLINE_API_URL    — mac mini funnel URL (e.g. https://...:8443)
 *   TRIPLINE_API_SECRET — Bearer token，與 mac mini /internal/mail/send 同一組
 */

export interface EmailEnv {
  TRIPLINE_API_URL?: string;
  TRIPLINE_API_SECRET?: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template?: string;     // 給 mac mini 寫 audit log，例 'verification' | 'forgot-password' | 'reset-password' | 'invitation'
}

export interface SendEmailResult {
  ok: true;
  /** Gmail SMTP messageId（為了 ops 追溯） */
  id: string;
  /** mac mini 端 sendMail latency in ms */
  elapsed: number;
}

export class EmailError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const MAILER_TIMEOUT_MS = 10_000;

export async function sendEmail(
  env: EmailEnv,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  if (!env.TRIPLINE_API_URL) {
    throw new EmailError('TRIPLINE_API_URL not configured', 500, null);
  }
  if (!env.TRIPLINE_API_SECRET) {
    throw new EmailError('TRIPLINE_API_SECRET not configured', 500, null);
  }
  // v2.33.99 security: SSRF / config-tamper guard — reject 非 Tailscale funnel
  // URL，避免 attacker 改 TRIPLINE_API_URL 後 TRIPLINE_API_SECRET 跟著洩漏。
  // inline check (避 dynamic import 在 worker runtime 行為差異)
  try {
    const parsed = new URL(env.TRIPLINE_API_URL);
    const host = parsed.hostname;
    const httpsOk = parsed.protocol === 'https:';
    const devOk = parsed.protocol === 'http:'
      && (host === 'localhost' || host === 'host.docker.internal' || host === '127.0.0.1');
    const hostOk = host.endsWith('.ts.net')
      || host === 'localhost' || host === 'host.docker.internal' || host === '127.0.0.1';
    if (!(httpsOk || devOk) || !hostOk) {
      throw new Error(`host ${host} 不在 allowlist`);
    }
  } catch (err) {
    throw new EmailError(`TRIPLINE_API_URL invalid: ${(err as Error).message}`, 500, null);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MAILER_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${env.TRIPLINE_API_URL}/internal/mail/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TRIPLINE_API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: params.to,
        subject: params.subject,
        html: params.html,
        ...(params.text ? { text: params.text } : {}),
        ...(params.template ? { template: params.template } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new EmailError(`Mailer fetch failed: ${msg}`, 0, null);
  }
  clearTimeout(timer);

  let respBody: unknown = null;
  try {
    respBody = await res.json();
  } catch {
    /* non-json response — keep null */
  }

  if (!res.ok) {
    const errMsg = (respBody as Record<string, unknown> | null)?.error;
    throw new EmailError(
      `Mailer responded ${res.status}${typeof errMsg === 'string' ? `: ${errMsg}` : ''}`,
      res.status,
      respBody,
    );
  }

  const id = (respBody as Record<string, unknown> | null)?.messageId;
  const elapsed = (respBody as Record<string, unknown> | null)?.elapsed;
  if (typeof id !== 'string') {
    throw new EmailError('Mailer response missing messageId', res.status, respBody);
  }
  return { ok: true, id, elapsed: typeof elapsed === 'number' ? elapsed : 0 };
}
