/**
 * POST /api/reports — 使用者錯誤回報（公開端點）
 * 不需認證，但有 rate limit + 蜜罐欄位防護
 *
 * v2.33.42 security audit: 加 field-length cap + 確認 tripId 存在於 trips
 * （防 attacker spam D1 + per-IP layered rate limit）。
 */
import { json, parseJsonBody } from '../../lib/utils';
import { AppError, buildRateLimitResponse } from '../../errors';
import { bumpRateLimit, clientIp, RATE_LIMITS } from '../../lib/rate-limit';
import type { Env } from '../../env';

const MAX_FIELD_LEN = 2000;

function clampField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\r\n]+/g, ' ').slice(0, MAX_FIELD_LEN);
  return trimmed || null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const db = env.DB;

  const body = await parseJsonBody<Record<string, unknown>>(request);

  // 蜜罐欄位 — bot 會填這個欄位
  if (body.website || body.email_confirm) {
    return json({ ok: true }); // 假裝成功，不存
  }

  const tripId = body.tripId as string;
  if (!tripId || typeof tripId !== 'string') {
    throw new AppError('DATA_VALIDATION', '缺少 tripId');
  }

  // v2.33.99 security: rate-limit bump 移到 tripExists 之前 — 之前 attacker 探測
  // 任意 tripId 觀察 404 vs 201 區分（trip-id enumeration oracle）+ 不消耗 quota，
  // 可無限枚舉 published trip slug (slug 是 user-chosen lowercase 易猜)。改先
  // bump quota，再 silently drop unknown tripId (回 201 with `ok:true` 不洩漏)。
  const ip = clientIp(request);
  const rl = await bumpRateLimit(db, `reports:ip:${ip}`, RATE_LIMITS.REPORTS_PER_IP);
  if (!rl.ok) {
    return buildRateLimitResponse(rl.retryAfter ?? 60, { error: { code: 'RATE_LIMITED', message: '回報過於頻繁，請稍後再試' } });
  }

  // v2.33.42: tripId 必須存在（防 attacker 拿任意字串 spam D1）
  // v2.33.99 security: 不存在時 silently drop 而非 404 — 拔 enum oracle 同時
  // 已 bump quota 故 attacker 仍受 200/24h 限制。
  const tripExists = await db.prepare('SELECT 1 FROM trips WHERE id = ? LIMIT 1').bind(tripId).first();
  if (!tripExists) {
    return json({ ok: true }, 201);
  }

  // 簡易 rate limit — 同 tripId + URL 30 秒內不可重複
  const url = clampField(body.url) ?? '';
  const recent = await db.prepare(
    "SELECT 1 FROM error_reports WHERE trip_id = ? AND url = ? AND created_at > datetime('now', '-30 seconds')"
  ).bind(tripId, url).first();
  if (recent) {
    throw new AppError('SYS_RATE_LIMIT');
  }

  await db.prepare(
    'INSERT INTO error_reports (trip_id, url, error_code, error_message, user_agent, context) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    tripId,
    url,
    clampField(body.errorCode),
    clampField(body.errorMessage),
    clampField(body.userAgent),
    clampField(body.context),
  ).run();

  return json({ ok: true }, 201);
};
