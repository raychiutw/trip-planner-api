/**
 * /api/dev/apps — V2-P4 OAuth client_app registration (developer dashboard backend)
 *
 * POST /api/dev/apps
 *   Body: { app_name, redirect_uris[], client_type, app_description?, homepage_url?, allowed_scopes? }
 *   Auth: requireSession
 *   產 client_id (always) + client_secret (confidential only, **一次回傳**)
 *   寫 client_apps with status='pending_review', owner_user_id=current user
 *
 * GET /api/dev/apps
 *   Auth: requireSession
 *   回 current user 擁有的 apps（不含 client_secret_hash）
 *
 * Security:
 *   - client_secret 只在 POST response 出現一次（hash 過後存 DB）
 *   - redirect_uri HTTPS only，localhost 例外（dev compat）
 *   - 新 app status='pending_review'，ops 手動核可才 active
 *   - owner_user_id 用 session uid，不接受 body 指定（防 ownership 偽造）
 */
import { parseJsonBody, rawJson } from '../../../lib/utils';
import { requireAccountUser } from '../../../lib/account-user';
import { hashPassword } from '../../../lib/password';
import { AppError } from '../../../errors';
import { validateRedirectUris } from '../../../lib/oauth-server/validate-redirect-uris';
import type { Env } from '../../../env';

const VALID_CLIENT_TYPES = ['public', 'confidential'] as const;
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const APP_NAME_MIN = 2;
const APP_NAME_MAX = 80;
const APP_DESCRIPTION_MAX = 500;

interface CreateAppBody {
  app_name?: string;
  app_description?: string;
  homepage_url?: string;
  redirect_uris?: string[];
  allowed_scopes?: string[];
  client_type?: 'public' | 'confidential';
}

/** RFC 4648 base32 lowercase encoder for human-readable client_id / client_secret. */
function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

function generateClientId(): string {
  const bytes = new Uint8Array(12); // 96 bits ≈ ~20 base32 chars
  crypto.getRandomValues(bytes);
  return `tp_${base32(bytes)}`;
}

function generateClientSecret(): string {
  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  return `tps_${base32(bytes)}`;
}

/**
 * v2.33.42 security audit: user-self-service registration MUST NOT include
 * `companion` / `ops:*` scope。之前接受 caller body 的任意 scope，雖然 status
 * 初始為 `pending_review`，但 ops 一旦 flip 為 active 而沒 scrub scope，attacker
 * 拿 client_credentials grant 即得維運身份（privilege escalation：companion 可
 * PATCH /requests + 寫 companion 收藏；ops:* 過 requireScope 維運 gate）。
 * Phase 3：舊 `admin` scope 已無作用（hasOpsScope 不再雙接受），但仍 block 以防混淆。
 *
 * Allowlist whitelist：companion / ops:* 必須 ops 手動 INSERT D1 才能擁有。
 */
const ALLOWED_USER_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);
export function validateScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return DEFAULT_SCOPES;
  if (scopes.length === 0) return DEFAULT_SCOPES;
  const cleaned = scopes
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.trim());
  if (cleaned.length === 0) return DEFAULT_SCOPES;
  for (const scope of cleaned) {
    if (!ALLOWED_USER_SCOPES.has(scope)) {
      throw new AppError(
        'DATA_VALIDATION',
        `不支援的 scope: ${scope}（user-self-service 限 openid/profile/email/offline_access）`,
      );
    }
  }
  return cleaned;
}

/**
 * homepage_url 驗證：mirror validateRedirectUris 的 protocol policy —
 * https only，localhost / 127.0.0.1 允許 http（dev compat）。
 * 空值回 null（欄位可選）。
 */
export function validateHomepageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('DATA_VALIDATION', 'homepage_url 必須是 https URL');
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new AppError('DATA_VALIDATION', 'homepage_url 必須是 https URL');
  }
  return trimmed;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const body = (await parseJsonBody<CreateAppBody>(context.request)) ?? {};

  const appName = (body.app_name ?? '').trim();
  if (!appName || appName.length < APP_NAME_MIN || appName.length > APP_NAME_MAX) {
    throw new AppError('DATA_VALIDATION', `app_name 長度需 ${APP_NAME_MIN}-${APP_NAME_MAX} 字`);
  }

  const clientType = body.client_type ?? 'public';
  if (!VALID_CLIENT_TYPES.includes(clientType)) {
    throw new AppError('DATA_VALIDATION', 'client_type 必須是 public 或 confidential');
  }

  const redirectUris = validateRedirectUris(body.redirect_uris);
  const allowedScopes = validateScopes(body.allowed_scopes);

  const appDescription = (body.app_description ?? '').trim();
  if (appDescription.length > APP_DESCRIPTION_MAX) {
    throw new AppError('DATA_VALIDATION', `app_description 不可超過 ${APP_DESCRIPTION_MAX} 字`);
  }

  const homepageUrl = validateHomepageUrl(body.homepage_url);

  const clientId = generateClientId();
  let clientSecret: string | null = null;
  let clientSecretHash: string | null = null;
  if (clientType === 'confidential') {
    clientSecret = generateClientSecret();
    clientSecretHash = await hashPassword(clientSecret);
  }

  await context.env.DB
    .prepare(
      `INSERT INTO client_apps
         (client_id, client_secret_hash, client_type, app_name, app_description,
          homepage_url, redirect_uris, allowed_scopes, owner_user_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      clientId,
      clientSecretHash,
      clientType,
      appName,
      appDescription || null,
      homepageUrl,
      JSON.stringify(redirectUris),
      JSON.stringify(allowedScopes),
      session.uid,
      'pending_review',
    )
    .run();

  return rawJson(
    {
      client_id: clientId,
      client_secret: clientSecret,
      app_name: appName,
      client_type: clientType,
      status: 'pending_review',
      redirect_uris: redirectUris,
      allowed_scopes: allowedScopes,
    },
    201,
  );
};

/**
 * Hardening: developer dashboard degrades gracefully if a stored
 * redirect_uris / allowed_scopes JSON column is corrupt — one bad row falls
 * back to [] instead of 500-ing the whole list.
 */
function safeParseArray(value: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);

  const result = await context.env.DB
    .prepare(
      `SELECT client_id, client_type, app_name, app_description, homepage_url,
              redirect_uris, allowed_scopes, status, created_at, updated_at
       FROM client_apps
       WHERE owner_user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(session.uid)
    .all<Record<string, unknown>>();

  const apps = (result.results ?? []).map((row) => ({
    ...row,
    redirect_uris: safeParseArray(row.redirect_uris),
    allowed_scopes: safeParseArray(row.allowed_scopes),
  }));

  return rawJson({ apps });
};

