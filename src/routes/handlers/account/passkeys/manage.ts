/**
 * passkey 管理（spec trip-planner#1677、ADR-0016）：
 *   GET    /api/account/passkeys       列出本人的 passkey（不回公鑰與簽名計數）
 *   PATCH  /api/account/passkeys/:id   改名（沿用註冊的規則：去前後空白、最多 50 字）
 *   DELETE /api/account/passkeys/:id   撤銷：刪資料列、寄通知信、寫稽核；不碰任何 session／token
 *
 * 所有權：每條 SQL 都帶 user_id；他人的 id 與不存在的 id 一律 404 PASSKEY_NOT_FOUND，不洩漏存在與否。
 * 通知信沿用註冊的做法：事後通知，寄信失敗只記錄與告警，不影響結果。
 */
import { requireAccountUser } from '../../../../lib/account-user';
import { AppError } from '../../../../errors';
import { recordAuthEvent } from '../../../../lib/auth-audit';
import { recordEmailEvent } from '../../../../lib/audit';
import { sendEmail, EmailError } from '../../../../lib/email';
import { alertAdminTelegram } from '../../../../lib/alert';
import { maskEmail } from '../../../../lib/pii';
import { passkeyRevokedNotice } from '../../../../lib/email-templates';
import { parseJsonBody, rawJson } from '../../../../lib/utils';
import { enforceStepUp } from '../../../../lib/step-up';
import type { Env } from '../../../../env';

const NAME_MAX = 50;

interface Row {
  id: string; name: string; transports: string | null; backup_eligible: number;
  created_at: string; last_used_at: string | null;
}
const COLUMNS = 'id, name, transports, backup_eligible, created_at, last_used_at';

const toDto = (r: Row) => ({
  id: r.id, name: r.name, transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
  backupEligible: r.backup_eligible === 1, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

const notFound = () => rawJson({ error: { code: 'PASSKEY_NOT_FOUND', message: '找不到這組 passkey（可能已移除或不屬於你）' } }, 404);

function credentialId(context: { params: unknown }): string {
  const id = (context.params as { id?: string }).id;
  if (!id || typeof id !== 'string') throw new AppError('DATA_VALIDATION', 'id 必填');
  return id;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const { results } = await context.env.DB
    .prepare(`SELECT ${COLUMNS} FROM passkey_credentials WHERE user_id = ? ORDER BY created_at, id`)
    .bind(user.uid).all<Row>();
  return rawJson({ passkeys: results.map(toDto) });
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const id = credentialId(context);
  const body = (await parseJsonBody<{ name?: unknown }>(context.request)) ?? {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '';
  if (!name) throw new AppError('DATA_VALIDATION', 'name 必填，且不可只有空白');

  const row = await context.env.DB
    .prepare(`UPDATE passkey_credentials SET name = ? WHERE id = ? AND user_id = ? RETURNING ${COLUMNS}`)
    .bind(name, id, user.uid).first<Row>();
  return row ? rawJson(toDto(row)) : notFound();
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  await enforceStepUp(context, user.auth);
  const { env, request } = context;
  const id = credentialId(context);

  const row = await env.DB
    .prepare('DELETE FROM passkey_credentials WHERE id = ? AND user_id = ? RETURNING name')
    .bind(id, user.uid).first<{ name: string }>();
  if (!row) return notFound();

  await recordAuthEvent(env.DB, request, { eventType: 'passkey_revoke', outcome: 'success', userId: user.uid }, env);
  try {
    await sendNotice(env, user.email, user.uid, row.name);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[passkey-revoke] notice failed:', (err as Error).message);
  }
  return rawJson({ ok: true, revoked_id: id });
};

/** 通知信：事後通知，失敗只記錄與告警，不影響回應。 */
async function sendNotice(env: Env, email: string, userId: string, passkeyName: string): Promise<void> {
  const profile = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first<{ display_name: string | null }>();
  const tpl = passkeyRevokedNotice(profile?.display_name ?? null, passkeyName);
  try {
    const result = await sendEmail(env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, template: 'passkey-revoked' });
    await recordEmailEvent(env.DB, { template: 'passkey-revoked', recipient: email, status: 'sent', latencyMs: result.elapsed, triggeredBy: email });
  } catch (err) {
    const msg = err instanceof EmailError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
    await recordEmailEvent(env.DB, { template: 'passkey-revoked', recipient: email, status: 'failed', error: msg, triggeredBy: email });
    await alertAdminTelegram(env, `移除 passkey 通知信寄送失敗（passkey 已移除）: ${maskEmail(email)} (${msg})`);
  }
}
