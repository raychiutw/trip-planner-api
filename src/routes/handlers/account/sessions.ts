/**
 * GET    /api/account/sessions — 列出目前使用者「有效的連線」（以 OAuth grant 為單位）
 * DELETE /api/account/sessions — 撤銷「其他」所有連線（保留目前這個憑證所屬的 grant）
 *
 * ⚠ 行為變更（api 拆分）：舊入口是 cookie session（session_devices，一台裝置一列）。
 * 新 api 沒有 cookie，登入的實體是 OAuth grant：一次登入／授權簽發的 AccessToken + RefreshToken
 * 共用同一個 grantId（換發 refresh 時沿用）。因此「已登入裝置」改為「有效的 grant」：
 *   sid           = grantId（撤銷時的識別，DELETE /sessions/:sid 用）
 *   ua_summary    = client 名稱（client_apps.app_name；查不到則為 client_id）
 *   client_id     = 新增欄位
 *   ip_hash_prefix= 恆為 null（oauth_models 不記錄 IP）
 *   created_at / last_seen_at = 該 grant 目前有效 token 的簽發時間（由到期時間回推；
 *                   oauth_models 無建立時間欄位，refresh 換發會更新）
 *   is_current    = 此請求所用的 access token 是否屬於該 grant
 *   current_sid   = 目前憑證的 grantId
 *
 * 範圍：只列該使用者（payload.user_id）未過期、未被消耗的 AccessToken／RefreshToken；
 * client_credentials（無 user_id）不在內。
 * Auth: requireAccountUser。
 */
import { requireAccountUser } from '../../../lib/account-user';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { rawJson } from '../../../lib/utils';
import type { Env } from '../../../env';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// UI 顯示上限；撤銷其他連線是 server 端全量處理，不受此限。
const SESSIONS_LIST_LIMIT = 100;

interface GrantInfo {
  grantId: string;
  clientId: string;
  issuedAt: number;
}

/** 目前請求所用 access token 的 grantId（Authorization: Bearer／DPoP）。查不到回 null。 */
export async function currentGrantId(request: Request, env: Env): Promise<string | null> {
  const m = /^(?:Bearer|DPoP)[ \t]+(.+)$/i.exec(request.headers.get('Authorization') ?? '');
  const token = m?.[1]?.trim();
  if (!token) return null;
  const row = await new D1Adapter(env.DB, 'AccessToken').find(token);
  return typeof row?.grantId === 'string' ? row.grantId : null;
}

/** 該使用者所有有效 grant（以 grantId 分組；同 grant 取最新簽發時間）。 */
export async function listUserGrants(env: Env, userId: string): Promise<GrantInfo[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT name, payload, expires_at FROM oauth_models
        WHERE name IN ('AccessToken', 'RefreshToken')
          AND json_extract(payload, '$.user_id') = ?
          AND expires_at > ?
          AND json_extract(payload, '$.consumed') IS NULL`,
    )
    .bind(userId, Date.now())
    .all<{ name: string; payload: string; expires_at: number }>();

  const grants = new Map<string, GrantInfo>();
  for (const row of results ?? []) {
    let p: { grantId?: unknown; client_id?: unknown };
    try { p = JSON.parse(row.payload); } catch { continue; }
    if (typeof p.grantId !== 'string' || !p.grantId) continue;
    const issuedAt = row.expires_at - (row.name === 'RefreshToken' ? REFRESH_TTL_MS : ACCESS_TTL_MS);
    const prev = grants.get(p.grantId);
    if (!prev || issuedAt > prev.issuedAt) {
      grants.set(p.grantId, {
        grantId: p.grantId,
        clientId: typeof p.client_id === 'string' ? p.client_id : '',
        issuedAt,
      });
    }
  }
  return [...grants.values()].sort((a, b) => b.issuedAt - a.issuedAt);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const [grants, currentSid] = await Promise.all([
    listUserGrants(context.env, user.uid),
    currentGrantId(context.request, context.env),
  ]);
  const top = grants.slice(0, SESSIONS_LIST_LIMIT);

  const names = new Map<string, string>();
  const clientIds = [...new Set(top.map((g) => g.clientId).filter(Boolean))];
  if (clientIds.length > 0) {
    const { results } = await context.env.DB
      .prepare(`SELECT client_id, app_name FROM client_apps WHERE client_id IN (${clientIds.map(() => '?').join(',')})`)
      .bind(...clientIds)
      .all<{ client_id: string; app_name: string }>();
    for (const r of results ?? []) names.set(r.client_id, r.app_name);
  }

  const sessions = top.map((g) => {
    const at = new Date(g.issuedAt).toISOString();
    return {
      sid: g.grantId,
      client_id: g.clientId,
      ua_summary: names.get(g.clientId) ?? g.clientId,
      ip_hash_prefix: null,
      created_at: at,
      last_seen_at: at,
      is_current: g.grantId === currentSid,
    };
  });
  return rawJson({ current_sid: currentSid, sessions });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const currentSid = await currentGrantId(context.request, context.env);
  const grants = await listUserGrants(context.env, user.uid);
  const adapter = new D1Adapter(context.env.DB, 'AccessToken');
  let revoked = 0;
  for (const g of grants) {
    if (g.grantId === currentSid) continue;
    await adapter.revokeByGrantId(g.grantId);
    revoked++;
  }
  return rawJson({ ok: true, revoked });
};
