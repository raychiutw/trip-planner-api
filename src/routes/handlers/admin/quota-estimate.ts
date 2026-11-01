/**
 * GET /api/admin/quota-estimate
 *
 * Returns month-to-date Google Maps request counts per consumed_api `method`,
 * ground-truth from Google Cloud Monitoring (interval = 當月 1 號 → 現在). Caller
 * maps each method to its free cap + overage price to compute free-tier headroom
 * (see scripts/lib/google-maps-quota.js calcHeadroom). No host→name map — the
 * `method` IS the billable SKU dimension (SearchText / GetPlace / Autocomplete
 * share one service host but bill differently).
 *
 * v2.46.x: 移除舊的 D1 proxy fallback（寫死 placeholder 常數 → 假底 $0.4433、且讓
 * 金額忽高忽低）。GCP 拿不到 → 502 MAPS_UPSTREAM_FAILED，寧可顯示錯誤也不顯示假數字。
 *
 * Required env: GOOGLE_CLOUD_SA_KEY + GOOGLE_CLOUD_PROJECT_ID（service account）。
 * Auth: admin only.
 *
 * Response 200: Array<{ method: string, count: number }>  (month-to-date)
 * Error 502: MAPS_UPSTREAM_FAILED — GCP Cloud Monitoring 無法取得（不投射假數字）。
 */

import { requireScope } from '../../../lib/permissions';
import { AppError } from '../../../errors';
import { fetchMapsQuotaFromCloudMonitoring } from '../../../lib/gcp-monitoring';
import type { Env } from '../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  requireScope(context, 'ops:maps');

  const counts = await fetchMapsQuotaFromCloudMonitoring(
    context.env as { GOOGLE_CLOUD_SA_KEY?: string; GOOGLE_CLOUD_PROJECT_ID?: string },
  );

  // GCP 拿不到（env 缺 / parse fail / API 失敗）→ 502，不投射假數字。
  // 對齊 route.ts / poi-search.ts：Google 上游/設定缺失一律 MAPS_UPSTREAM_FAILED。
  if (!counts) {
    throw new AppError(
      'MAPS_UPSTREAM_FAILED',
      'Google Cloud Monitoring 無法取得用量（GOOGLE_CLOUD_SA_KEY / GOOGLE_CLOUD_PROJECT_ID 未設定或 API 失敗）',
    );
  }

  // Pass through real per-method month-to-date counts. Caller (calcHeadroom)
  // ignores methods without a known free cap (e.g. non-Maps billingbudgets).
  return new Response(JSON.stringify(counts), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
