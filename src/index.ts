import { app } from './app';
import type { Env } from './env';
import { checkRequestStall } from './lib/request-stall-heartbeat';
import { isCleanupCron, runCleanup } from './lib/cleanup-cron';

export default {
  fetch: app.fetch,
  // Cron Trigger（wrangler.toml 的 [env.production.triggers]）：清理排程依 event.cron 分派；
  // 其餘（*/10）為外部心跳，Telegram 未設定時靜默。
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (isCleanupCron(event.cron)) {
      ctx.waitUntil(runCleanup(env, event.cron));
      return;
    }
    ctx.waitUntil(checkRequestStall(env).catch((err) => console.error('[stall-heartbeat] failed', err instanceof Error ? err.message : String(err))));
  },
};
