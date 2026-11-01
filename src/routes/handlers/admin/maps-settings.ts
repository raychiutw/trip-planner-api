/**
 * GET /api/admin/maps-settings
 *
 * 回傳 Google Maps kill switch 的**鎖定狀態**。消費者：scripts/daily-check.js。
 *
 * ⚠️ 2026-07-29 拿掉 budget_usd / lock_threshold_pct / unlock_threshold_pct 三個欄位。
 * Google 於 2025-03 取消 $200/月抵免、改成各 SKU 各自的免費月額度，監控端早就改算
 * free-cap headroom %，那三個 key 卻還留著並被這支 API 原封不動回出去 —— 讀到的人
 * （或 agent）會以為還有一筆 $200 預算在管控。其中 unlock_threshold_pct 要驅動的
 * 「自動解鎖」從未實作。門檻改寫死成 scripts/lib/google-maps-quota.js 的 CRITICAL_PCT。
 * **別把它們加回來**（tests/unit/daily-check-google-maps.test.ts 守著）。
 *
 * Auth: ops:maps scope（全域 admin 已於 v2.55.5-v2.55.7 移除）。
 *
 * Response: { is_locked: boolean, locked_reason: string, locked_at: string | null }
 */

import { requireScope } from '../../../lib/permissions';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  requireScope(context, 'ops:maps');
  const { results } = await context.env.DB.prepare(
    `SELECT key, value FROM app_settings
     WHERE key IN (
       'google_maps_locked',
       'google_maps_locked_reason',
       'google_maps_locked_at'
     )`,
  ).all<{ key: string; value: string }>();

  const map = new Map((results || []).map((r) => [r.key, r.value]));
  return new Response(
    JSON.stringify({
      is_locked: map.get('google_maps_locked') === 'true',
      locked_reason: map.get('google_maps_locked_reason') || '',
      locked_at: map.get('google_maps_locked_at') || null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
