import type { Env } from '../env';

/**
 * 排程清理（trip-planner#1627 階段 1）：web repo 三支 GitHub Actions 直連 production D1 的 DELETE，
 * 等價搬進本 Worker 的 Cron Trigger。SQL 逐字取自 web 的 scripts/cleanup-*.sql，cutoff 與保留規則不得放寬。
 * 全部 idempotent（重跑 0 效果），與 web 的 workflow 並行期間互不影響。
 *
 * cron 表達式沿用原 workflow 的頻率；event.cron 必須與 wrangler.toml 的 crons 字串一致。
 * 每支清理獨立 try/catch：失敗只 console.error，不影響同 cron 內其他支。
 * log 只寫表名與刪除筆數，不含任何使用者資料。刻意不發 Telegram（原 workflow 的失敗通知由 GitHub 端負責，這裡避免噪音）。
 */
export const CRON_RATE_LIMIT = '0 * * * *'; // rate-limit-cleanup.yml：每小時
export const CRON_SHARES = '17 3 * * *'; // share-cleanup.yml：每日 03:17 UTC
export const CRON_INVITATIONS = '0 3 * * *'; // invitation-cleanup.yml：每日 03:00 UTC

type Task = { table: string; sql: string };

// cleanup-rate-limit.sql：鎖中（locked_until 非 NULL）一律保留，只清 unlocked 且窗口已過 1 小時的。
const RATE_LIMIT: Task = {
  table: 'rate_limit_buckets',
  sql: `DELETE FROM rate_limit_buckets
        WHERE locked_until IS NULL
          AND window_start + 3600000 < (unixepoch() * 1000)`,
};
// cleanup-expired-shares.sql：expires_at 為 epoch ms，NULL = 永久不清；過期後 30 天寬限。
const SHARES: Task = {
  table: 'trip_shares',
  sql: `DELETE FROM trip_shares
        WHERE expires_at IS NOT NULL
          AND expires_at < (CAST(strftime('%s', 'now') AS INTEGER) - 2592000) * 1000`,
};
// cleanup-orphan-cloned-trips.sql：clone 失敗殘留（無任何 permission）且超過 1 天；FK CASCADE 帶走子資料。
const ORPHAN_TRIPS: Task = {
  table: 'trips',
  sql: `DELETE FROM trips
        WHERE data_source = 'cloned'
          AND created_at < datetime('now', '-1 day')
          AND NOT EXISTS (SELECT 1 FROM trip_permissions tp WHERE tp.trip_id = trips.id)`,
};
// cleanup-invitations.sql：已接受或未接受且過期，皆滿 30 天才刪；pending（未過期）保留。
const INVITATIONS: Task = {
  table: 'trip_invitations',
  sql: `DELETE FROM trip_invitations
        WHERE (accepted_at IS NOT NULL AND accepted_at < datetime('now', '-30 days'))
           OR (accepted_at IS NULL AND expires_at < datetime('now', '-30 days'))`,
};

const TASKS: Record<string, Task[]> = {
  [CRON_RATE_LIMIT]: [RATE_LIMIT],
  [CRON_SHARES]: [SHARES, ORPHAN_TRIPS],
  [CRON_INVITATIONS]: [INVITATIONS],
};

export const isCleanupCron = (cron: string) => cron in TASKS;

export async function runCleanup(env: Env, cron: string): Promise<void> {
  for (const t of TASKS[cron] ?? []) {
    try {
      const r = await env.DB.prepare(t.sql).run();
      console.log(`[cleanup] ${t.table} deleted=${r.meta.changes}`);
    } catch (err) {
      console.error(`[cleanup] ${t.table} failed`, err instanceof Error ? err.message : String(err));
    }
  }
}
