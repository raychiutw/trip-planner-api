/**
 * GET /api/oauth/userinfo — return current session user
 *
 * V2-P1 — SPA 用此 endpoint 在 page load 取得 logged-in user info（取代
 * sidebar hardcode email）。OIDC userinfo endpoint 通常 return token claims；
 * 這裡 V2-P1 階段 return D1 users row 的 subset。
 *
 * Auth: required（bearer access token，須對應使用者；service token → 401）。
 * （行為變更：新 api 沒有 cookie session，改認 bearer。）
 *
 * Response shape (200):
 *   { id, email, displayName?, avatarUrl?, emailVerified: boolean, createdAt }
 *
 * 不含：refresh token / Google profile direct passthrough（V2-P5 OIDC server
 * mode 才回 standard OIDC userinfo claims）
 */
import { getAuth } from '../../../lib/utils';
import { AppError } from '../../../errors';
import type { Env } from '../../../env';

interface UserRow {
  id: string;
  email: string;
  email_verified_at: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  // Use the _middleware-decorated user when present. NOTE: _middleware forces
  // context.data.auth = null for ALL /api/oauth/* EXCEPT the local DEV_MOCK_EMAIL path
  // (which decorates auth *before* the oauth/* short-circuit). So in practice this only
  // populates a user for local mock auth — which is the fix: userinfo used to re-read the
  // session cookie via requireSessionUser, ignoring mock auth and 401-ing the frontend
  // page-load probe in local dev. In prod (no DEV_MOCK_EMAIL) auth is null here, so we fall
  // back to requireSessionUser exactly as before — prod behavior unchanged.
  const uid = getAuth(context)?.userId;
  if (!uid) throw new AppError('AUTH_REQUIRED'); // service token 沒有使用者身份

  const row = await context.env.DB
    .prepare(
      'SELECT id, email, email_verified_at, display_name, avatar_url, created_at FROM users WHERE id = ?',
    )
    .bind(uid)
    .first<UserRow>();

  if (!row) {
    // Session 指向已不存在的 user — 可能 user 被 admin 刪了 / DB 出錯
    throw new AppError('AUTH_INVALID', 'Session user 不存在');
  }

  return new Response(
    JSON.stringify({
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified_at !== null,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at.endsWith('Z') ? row.created_at : row.created_at + 'Z',
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Don't cache — user 資料可能變動
        'cache-control': 'private, no-store',
      },
    },
  );
};
