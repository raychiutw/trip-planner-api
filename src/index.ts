import { app } from './app';
import type { Env } from './env';
import { checkRequestStall } from './lib/request-stall-heartbeat';

export default {
  fetch: app.fetch,
  // Cron Trigger（wrangler.toml 的 [env.production.triggers]）：外部心跳，Telegram 未設定時靜默。
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkRequestStall(env).catch((err) => console.error('[stall-heartbeat] failed', err instanceof Error ? err.message : String(err))));
  },
};
