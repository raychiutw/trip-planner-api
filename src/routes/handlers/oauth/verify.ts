/**
 * POST /api/oauth/verify (v2.33.59 round 13 — primary path)
 * GET  /api/oauth/verify?token=<token> (backward compat for emails sent < v2.33.59)
 *
 * V2-P2 — Email verification endpoint。
 *
 * **POST flow (recommended)**:
 *   - Body: { token }
 *   - Returns JSON { ok: true } or { error: 'expired' | 'used' | 'server_error' }
 *   - 用 SPA page `/auth/verify-email` (auto-POST 後跳轉 /login?verified=1)
 *   - Defense: 防 email client image-preview consume / Referer leak / history leak
 *
 * **GET flow (legacy, kept ≥ 30 day for backward compat with already-sent emails)**:
 *   - 同舊 V2-P2 行為，302 redirect 配 verify_error / verified
 *   - 加 `Referrer-Policy: no-referrer` 部分緩解 Referer leak
 *
 * Common consume logic:
 *   1. Extract token
 *   2. D1Adapter find token (oauth_models name='EmailVerification')
 *   3. If row missing → 'expired'
 *   4. If row.consumed → 'used'
 *   5. UPDATE users SET email_verified_at
 *   6. consume token (keep row until TTL for re-click 'used' message)
 */
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { parseJsonBody } from '../../../lib/utils';
import type { Env } from '../../../env';

interface VerifyTokenPayload {
  userId: string;
  email: string;
  createdAt: number;
  /** Set on successful verify — re-clicks within TTL see this and return verify_error=used */
  consumed?: number;
  [key: string]: unknown;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      // v2.33.59 round 13 H2: Referrer-Policy 防 token 經 Referer 漏到 /login
      // 內 outbound resource (analytics / Sentry / map tile 等)
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * Shared consume logic — used by both POST (primary) and GET (backward compat).
 * Returns 'ok' | 'expired' | 'used' | 'server_error' (raw status code).
 */
async function consumeVerifyToken(
  env: Env,
  token: string,
): Promise<'ok' | 'expired' | 'used' | 'server_error'> {
  const adapter = new D1Adapter(env.DB, 'EmailVerification');
  const tokenRow = (await adapter.find(token)) as VerifyTokenPayload | undefined;
  if (!tokenRow) return 'expired';
  if (tokenRow.consumed) return 'used';

  try {
    await env.DB
      .prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), tokenRow.userId)
      .run();
  } catch {
    return 'server_error';
  }
  // v2.33.58 round 12 C4: consume 改 boolean，verify 無 race detect 需求。
  void (await adapter.consume(token));
  return 'ok';
}

/**
 * v2.33.59 round 13: POST primary path — returns JSON.
 * Body: { token: string }
 * Response: { ok: true } | { error: 'missing_token' | 'expired' | 'used' | 'server_error' }
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = await parseJsonBody<{ token?: unknown }>(context.request);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return jsonResponse({ error: 'missing_token' }, 400);
  }

  const result = await consumeVerifyToken(context.env, token);
  if (result === 'ok') return jsonResponse({ ok: true });
  return jsonResponse({ error: result }, result === 'server_error' ? 500 : 400);
};

/**
 * Backward compat — GET path 留給 v2.33.59 前寄出的 email link。≥30 天後可拔。
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const token = (url.searchParams.get('token') ?? '').trim();

  if (!token) {
    return redirect('/login?verify_error=missing_token');
  }

  const result = await consumeVerifyToken(context.env, token);
  if (result === 'ok') return redirect('/login?verified=1');
  return redirect(`/login?verify_error=${result}`);
};
