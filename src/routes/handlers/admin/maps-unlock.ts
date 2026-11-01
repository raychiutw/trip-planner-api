/**
 * POST /api/admin/maps-unlock — Manually release Google Maps kill switch.
 *
 * 人工維運逃生口：這是**唯一**能把 lock 設回 false 的路徑（maps-lock 只上鎖、
 * maps-settings 只讀），配額 kill switch 觸發後靠它解鎖。
 *
 * ⚠️ 沒有任何程式呼叫它 —— 2026-07-29 查證 scripts/daily-check.js 只打
 * maps-settings 與 quota-estimate。原註解宣稱「daily-check auto-unlock 也會
 * 呼叫」，那是過期的。**別因為「沒人呼叫」就刪掉它。**
 *
 * Auth: ops:maps scope（全域 admin 已於 v2.55.5-v2.55.7 移除）。
 * Response: { "locked": false, "unlocked_at": ISO timestamp, "previous_reason": string }
 */

import { requireScope } from '../../../lib/permissions';
import { setLockState } from '../../../lib/maps-lock';
import { logAudit } from '../../../lib/audit';
import type { Env } from '../../../env';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireScope(context, 'ops:maps');

  const { at, previousReason } = await setLockState(context.env.DB, false, {
    actor: auth.email,
    reason: '',
  });

  await logAudit(context.env.DB, {
    tripId: '',
    tableName: 'app_settings',
    recordId: null,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({
      key: 'google_maps_locked',
      from: 'true',
      to: 'false',
      previous_reason: previousReason,
    }),
  });

  return new Response(
    JSON.stringify({ locked: false, unlocked_at: at, previous_reason: previousReason }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
