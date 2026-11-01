/**
 * /api/dev/apps/:client_id — V2-P4 OAuth client_app detail / update / suspend
 *
 * GET /api/dev/apps/:client_id
 *   require: session + ownership
 *   return: full client_app row (no client_secret_hash)
 *
 * PATCH /api/dev/apps/:client_id
 *   require: session + ownership
 *   body: { app_name?, app_description?, app_logo_url?, homepage_url?,
 *           redirect_uris?, allowed_scopes? }
 *   cannot: change client_id / client_type / status / owner_user_id / secret hash
 *
 * DELETE /api/dev/apps/:client_id
 *   require: session + ownership
 *   soft-delete: UPDATE status='suspended'（保留 audit trail；authorize.ts 會擋 status != 'active'）
 */
import { parseJsonBody, rawJson } from '../../../../lib/utils';
import { requireAccountUser } from '../../../../lib/account-user';
import { AppError } from '../../../../errors';
import { validateRedirectUris } from '../../../../lib/oauth-server/validate-redirect-uris';
import { validateScopes, validateHomepageUrl } from '../apps';
import type { Env } from '../../../../env';

interface ClientAppRow {
  client_id: string;
  client_type: string;
  app_name: string;
  app_description: string | null;
  app_logo_url: string | null;
  homepage_url: string | null;
  redirect_uris: string;
  allowed_scopes: string;
  owner_user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PatchAppBody {
  app_name?: string;
  app_description?: string | null;
  app_logo_url?: string | null;
  homepage_url?: string | null;
  redirect_uris?: string[];
  allowed_scopes?: string[];
}

const APP_NAME_MIN = 2;
const APP_NAME_MAX = 80;

function shapeAppRow(row: ClientAppRow): Record<string, unknown> {
  return {
    client_id: row.client_id,
    client_type: row.client_type,
    app_name: row.app_name,
    app_description: row.app_description,
    app_logo_url: row.app_logo_url,
    homepage_url: row.homepage_url,
    redirect_uris: JSON.parse(row.redirect_uris) as string[],
    allowed_scopes: JSON.parse(row.allowed_scopes) as string[],
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadOwnedApp(
  db: Env['DB'],
  clientId: string,
  ownerUserId: string,
): Promise<ClientAppRow | null> {
  return db
    .prepare(
      `SELECT client_id, client_type, app_name, app_description, app_logo_url,
              homepage_url, redirect_uris, allowed_scopes, owner_user_id, status,
              created_at, updated_at
       FROM client_apps
       WHERE client_id = ? AND owner_user_id = ?`,
    )
    .bind(clientId, ownerUserId)
    .first<ClientAppRow>();
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const clientId = (context.params as { client_id?: string }).client_id;
  if (!clientId) throw new AppError('DATA_VALIDATION', 'client_id 必填');

  const row = await loadOwnedApp(context.env.DB, clientId, session.uid);
  if (!row) {
    return rawJson({ error: { code: 'APP_NOT_FOUND', message: '找不到此應用' } }, 404);
  }
  return rawJson(shapeAppRow(row));
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const clientId = (context.params as { client_id?: string }).client_id;
  if (!clientId) throw new AppError('DATA_VALIDATION', 'client_id 必填');

  const existing = await loadOwnedApp(context.env.DB, clientId, session.uid);
  if (!existing) {
    return rawJson({ error: { code: 'APP_NOT_FOUND', message: '找不到此應用' } }, 404);
  }

  const body = (await parseJsonBody<PatchAppBody>(context.request)) ?? {};

  // Build dynamic UPDATE based on provided fields
  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof body.app_name === 'string') {
    const name = body.app_name.trim();
    if (name.length < APP_NAME_MIN || name.length > APP_NAME_MAX) {
      throw new AppError('DATA_VALIDATION', `app_name 長度需 ${APP_NAME_MIN}-${APP_NAME_MAX} 字`);
    }
    updates.push('app_name = ?');
    values.push(name);
  }
  if (body.app_description !== undefined) {
    updates.push('app_description = ?');
    values.push(body.app_description);
  }
  if (body.app_logo_url !== undefined) {
    // https-only（reject javascript:/data:/http）—— 這些欄位經 /api/oauth/client-info 公開，
    // 未來若被 render 成 <img src>/<a href> 即成 XSS/open-redirect；在寫入端擋掉。
    updates.push('app_logo_url = ?');
    values.push(validateHomepageUrl(body.app_logo_url));
  }
  if (body.homepage_url !== undefined) {
    updates.push('homepage_url = ?');
    values.push(validateHomepageUrl(body.homepage_url));
  }
  if (body.redirect_uris !== undefined) {
    const uris = validateRedirectUris(body.redirect_uris);
    updates.push('redirect_uris = ?');
    values.push(JSON.stringify(uris));
  }
  if (body.allowed_scopes !== undefined) {
    // Non-empty guard FIRST (validateScopes would silently fall back to
    // DEFAULT_SCOPES on []), then enforce the user-self-service allowlist —
    // same gate as POST. Closes a privilege-escalation hole: PATCH previously
    // accepted any string (e.g. 'companion' / 'ops:*'), letting an app owner mint
    // a maintenance-scoped client_credentials token. (Phase 3：舊 'admin' scope 已無作用)
    if (!Array.isArray(body.allowed_scopes) || body.allowed_scopes.length === 0) {
      throw new AppError('DATA_VALIDATION', 'allowed_scopes 必須是非空陣列');
    }
    const cleaned = validateScopes(body.allowed_scopes);
    updates.push('allowed_scopes = ?');
    values.push(JSON.stringify(cleaned));
  }

  if (updates.length === 0) {
    throw new AppError('DATA_VALIDATION', '沒有可更新的欄位');
  }

  updates.push("updated_at = datetime('now')");

  await context.env.DB
    .prepare(
      `UPDATE client_apps SET ${updates.join(', ')} WHERE client_id = ? AND owner_user_id = ?`,
    )
    .bind(...values, clientId, session.uid)
    .run();

  // Return updated row
  const updated = await loadOwnedApp(context.env.DB, clientId, session.uid);
  if (!updated) {
    throw new AppError('SYS_INTERNAL', 'app 更新後讀取失敗');
  }
  return rawJson(shapeAppRow(updated));
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const clientId = (context.params as { client_id?: string }).client_id;
  if (!clientId) throw new AppError('DATA_VALIDATION', 'client_id 必填');

  const existing = await loadOwnedApp(context.env.DB, clientId, session.uid);
  if (!existing) {
    return rawJson({ error: { code: 'APP_NOT_FOUND', message: '找不到此應用' } }, 404);
  }

  // Soft-delete: status='suspended'。保留 audit trail；authorize.ts 會
  // 擋 status != 'active'，所以 effective immediately。
  await context.env.DB
    .prepare(
      `UPDATE client_apps
       SET status = 'suspended', updated_at = datetime('now')
       WHERE client_id = ? AND owner_user_id = ?`,
    )
    .bind(clientId, session.uid)
    .run();

  return rawJson({ ok: true, suspended_client_id: clientId });
};
