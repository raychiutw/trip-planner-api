/**
 * api_logs 紀錄（自舊 functions/api/_middleware.ts 搬來）。
 *
 * 只記 method / pathname / status / error / duration / source。
 * **不記** Authorization、query string（SSE ticket 等放在 query）、request／response body。
 * 寫入走 waitUntil，不拖慢回應；沒有 executionCtx（測試）時由呼叫端的 harness 收尾。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from '../errors';
import type { AppEnv } from '../env';
import { alertAdminTelegram } from '../lib/alert';

export type ApiLogSource = 'scheduler' | 'companion' | 'service_token' | 'user_jwt' | 'anonymous';

/**
 * 偵測 request source，用於 api_logs.source 欄位。
 * 優先順序: scheduler > companion > service_token／user_jwt（依已驗證的 auth）> anonymous。
 *
 * ⚠️ Trust boundary: scheduler／companion 是 **self-reported telemetry**（X-Tripline-Source、X-Request-Scope
 * 可被匿名呼叫端偽造），不是 auth decision；消費端不能單憑 source 做授權。
 * 舊入口用 CF-Access-Client-* 與 CF_Authorization cookie 判斷 service_token／user_jwt；新 api 沒有這兩者，
 * 改看路由 middleware 驗證後掛在 context 的 auth（service token → service_token，使用者 token → user_jwt）。
 * 帶了 Authorization 但驗證失敗（auth 為空）一律當 anonymous，與舊入口「偽造的 CF header 算 anonymous」一致。
 */
export function detectSource(request: Request, auth?: { isServiceToken?: boolean } | null): ApiLogSource {
  if (request.headers.get('X-Tripline-Source') === 'scheduler') return 'scheduler';
  if (request.headers.get('X-Request-Scope') === 'companion') return 'companion';
  if (auth) return auth.isServiceToken ? 'service_token' : 'user_jwt';
  return 'anonymous';
}

/**
 * 排程一個「寫 log／發告警」的工作。thunk 同步丟錯（例如 DB 壞到 prepare 就失敗）或 promise reject 都吞掉：
 * 觀測性的失敗不能改變回應（D1 故障時 /api/health 仍要回 503，而不是 500）。
 */
function defer(c: Context<AppEnv>, work: () => Promise<unknown>): void {
  let guarded: Promise<unknown>;
  try {
    guarded = work().catch(() => {});
  } catch {
    return;
  }
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // 沒有 executionCtx：fire-and-forget
  }
}

export const apiLogs: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  const pathname = new URL(c.req.url).pathname;
  // 延後到 next() 之後才算：路由 middleware 此時已把驗證過的 auth 掛上 context
  let cached: ApiLogSource | undefined;
  const getSource = () => (cached ??= detectSource(c.req.raw, c.get('auth')));

  // bot scanner 的匿名 4xx 不寫 log（燒 D1 writes、表無上限成長）；已帶身分的 4xx 仍記；5xx 一律記。
  const shouldLog = (status: number) => status >= 500 || (status >= 400 && getSource() !== 'anonymous');

  await next();

  const status = c.res.status;
  if (!shouldLog(status)) return;
  const duration = Date.now() - start;

  const err = c.error;
  let errorText: string | null = null;
  if (err instanceof AppError) errorText = err.detail ? `${err.code}: ${err.detail}` : err.code;
  else if (err) errorText = err instanceof Error ? err.message : String(err);

  defer(c, () =>
    c.env.DB.prepare('INSERT INTO api_logs (method, path, status, error, duration, source) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.req.method, pathname, status, errorText, duration, getSource())
      .run(),
  );

  // 非預期例外（不是 AppError）→ 即時 Telegram 告警（舊 v2.33.129 G5）。訊息只含 method/path/source/錯誤摘要。
  if (err && !(err instanceof AppError)) {
    defer(c, () =>
      alertAdminTelegram(
        c.env,
        `🚨 Tripline API 5xx unhandled\n${c.req.method} ${pathname}\nsource=${getSource()} duration=${duration}ms\nerror: ${(errorText ?? '').slice(0, 200)}`,
      ),
    );
  }
};
