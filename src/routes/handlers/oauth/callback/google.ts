/**
 * GET /api/oauth/callback/google?code=...&state=... —— Google 登入的 callback。
 *
 * 設計變更（沒有 cookie）：不再發 session，而是 302 到 client 註冊的 redirect_uri，帶「我們自己」的
 * authorization code（同 token endpoint 能兌換）。
 *
 * Flow：
 *   1. 沒有 Google 設定 → 503 OAUTH_NOT_CONFIGURED。
 *   2. 以 state 領取 GoogleLoginState（單次使用）。缺 state、不存在、已使用、過期一律同一個 400 OAUTH_INVALID_STATE。
 *   3. 用 code＋PKCE verifier 向 Google 換 token；驗 id_token（簽章、aud、iss、exp、email_verified）並比對 nonce。
 *   4. 建立或連結使用者（email 合併規則同舊版：未驗證的既有帳號不合併，防 squat）。
 *   5. 產生我們的 authorization code → 302 redirect_uri?code=&state=。
 *      第一方 client 的 code 沿用 routes/login.ts 的形狀：redirect_uri=null、可帶 dpop_jkt、60 秒有效。
 *   Google 回 error（例如使用者取消）：state 有效時 302 回 client 帶 error=access_denied，否則同樣視為 state 錯誤。
 */
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { verifyGoogleIdToken } from '../../../../lib/oauth-client/google-id-token';
import { recordAuthEvent } from '../../../../lib/auth-audit';
import { buildClientRedirect, takeOnce } from '../../../../lib/oauth-single-use';
import { generateOpaqueToken, getPublicOrigin } from '../../../../lib/utils';
import type { Env } from '../../../../env';
import { notConfigured } from '../login/google';

const CODE_TTL_SEC = 10 * 60;
const FIRST_PARTY_CODE_TTL_SEC = 60;

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface GoogleLoginStatePayload {
  provider?: string;
  client_id?: string;
  redirect_uri?: string;
  scopes?: string[];
  client_state?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: 'S256' | null;
  nonce?: string;
  google_code_verifier?: string;
  first_party?: boolean;
  dpop_jkt?: string;
}

function errorResponse(code: string, message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

const invalidState = () => errorResponse('OAUTH_INVALID_STATE', 'state 無效、過期或已使用 — 請重新登入');

/**
 * Recover from a concurrent first-time-login race: two requests for the same
 * Google `sub` both miss the initial SELECT and race to INSERT auth_identities,
 * one losing on the UNIQUE(provider, provider_user_id) constraint. On a
 * UNIQUE/constraint error, re-run the identity lookup to adopt the winner's
 * user_id (mirrors signup.ts's `includes('UNIQUE')` guard). Non-UNIQUE failures
 * — and a UNIQUE error with no recoverable row — re-throw so genuine DB errors
 * still surface as 500 rather than being masked.
 */
async function recoverIdentityRace(db: D1Database, sub: string, err: unknown): Promise<string> {
  const msg = (err as Error)?.message ?? '';
  const upper = msg.toUpperCase();
  if (!upper.includes('UNIQUE') && !upper.includes('CONSTRAINT')) {
    throw err;
  }
  const winner = await db
    .prepare('SELECT user_id FROM auth_identities WHERE provider = ? AND provider_user_id = ?')
    .bind('google', sub)
    .first<{ user_id: string }>();
  if (!winner) {
    throw err;
  }
  return winner.user_id;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const clientId = context.env.GOOGLE_CLIENT_ID;
  const clientSecret = context.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return notConfigured('Google 登入尚未設定（GOOGLE_CLIENT_ID／GOOGLE_CLIENT_SECRET）');
  }

  // 1. 領取 state（單次使用；CSRF 與重放防護）
  const row = state ? ((await takeOnce(context.env.DB, 'GoogleLoginState', state)) as GoogleLoginStatePayload | undefined) : undefined;
  if (
    !row || row.provider !== 'google' || typeof row.client_id !== 'string' || typeof row.redirect_uri !== 'string'
    || !Array.isArray(row.scopes) || typeof row.nonce !== 'string' || typeof row.google_code_verifier !== 'string'
  ) {
    return invalidState();
  }

  // Google 端失敗（使用者取消等）：導回 client（redirect_uri 是 login 時驗過的）
  if (url.searchParams.get('error') || !code) {
    return new Response(null, {
      status: 302,
      headers: { Location: buildClientRedirect(row.redirect_uri, { error: 'access_denied', state: row.client_state ?? null }) },
    });
  }

  // 2. 向 Google 換 token（帶 PKCE verifier）
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${getPublicOrigin(context.env, context.request)}/api/oauth/callback/google`,
      grant_type: 'authorization_code',
      code_verifier: row.google_code_verifier,
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return errorResponse('OAUTH_TOKEN_EXCHANGE_FAILED', `Google token exchange ${tokenRes.status}: ${errText.slice(0, 200)}`, 502);
  }
  const tokenJson = (await tokenRes.json()) as GoogleTokenResponse;

  // 3. 驗 id_token（簽章、aud、iss、exp、email_verified），並比對 nonce（防 id_token 重放／替換）
  let claims;
  try {
    claims = await verifyGoogleIdToken(tokenJson.id_token, clientId);
  } catch (err) {
    return errorResponse('OAUTH_INVALID_ID_TOKEN', `id_token 驗證失敗: ${(err as Error).message}`, 401);
  }
  if (claims['nonce'] !== row.nonce) {
    return errorResponse('OAUTH_INVALID_ID_TOKEN', 'id_token nonce 不符', 401);
  }
  const sub = claims.sub;
  const email = typeof claims.email === 'string' ? claims.email : '';
  const email_verified = claims.email_verified === true;
  const name = typeof claims.name === 'string' ? claims.name : undefined;
  const picture = typeof claims.picture === 'string' ? claims.picture : undefined;
  if (!sub || !email) {
    return errorResponse('OAUTH_INVALID_ID_TOKEN', 'id_token 缺 sub/email claim');
  }
  const now = new Date().toISOString();
  const db = context.env.DB;

  // 4. 建立或連結使用者
  const existing = await db
    .prepare('SELECT user_id FROM auth_identities WHERE provider = ? AND provider_user_id = ?')
    .bind('google', sub)
    .first<{ user_id: string }>();

  let userId: string;
  if (existing) {
    userId = existing.user_id;
    await db
      .prepare('UPDATE auth_identities SET last_used_at = ? WHERE provider = ? AND provider_user_id = ?')
      .bind(now, 'google', sub)
      .run();
  } else {
    // 新帳號路徑強制 email_verified=true，防 attacker 用 alias email 預先 squat victim 的 email
    if (!email_verified) {
      return errorResponse('OAUTH_EMAIL_UNVERIFIED', 'Google account email 未驗證，請先在 Google 完成 email 驗證後再登入', 400);
    }
    const existingUserByEmail = await db
      .prepare('SELECT id, email_verified_at FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; email_verified_at: string | null }>();

    if (existingUserByEmail) {
      // 已存在的帳號：已驗證才連結 Google identity；未驗證則拒絕（防 squat）
      if (!existingUserByEmail.email_verified_at) {
        return errorResponse('OAUTH_EMAIL_CONFLICT', '此 email 已註冊但未驗證 — 請先用密碼登入並完成 email 驗證，再合併 Google 登入', 409);
      }
      userId = existingUserByEmail.id;
      try {
        await db
          .prepare('INSERT INTO auth_identities (user_id, provider, provider_user_id, last_used_at) VALUES (?, ?, ?, ?)')
          .bind(userId, 'google', sub, now)
          .run();
      } catch (err) {
        userId = await recoverIdentityRace(db, sub, err);
      }
    } else {
      userId = crypto.randomUUID();
      try {
        await db
          .prepare('INSERT INTO users (id, email, email_verified_at, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, email, now, name ?? null, picture ?? null)
          .run();
        await db
          .prepare('INSERT INTO auth_identities (user_id, provider, provider_user_id, last_used_at) VALUES (?, ?, ?, ?)')
          .bind(userId, 'google', sub, now)
          .run();
      } catch (err) {
        userId = await recoverIdentityRace(db, sub, err);
      }
    }
  }

  // 停權帳號不發 code（與 routes/login.ts 一致）
  const status = await db.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>();
  if (status && status.status !== 'active') {
    await recordAuthEvent(db, context.request, { eventType: 'login', outcome: 'failure', userId, clientId: row.client_id, failureReason: 'account_suspended' }, context.env);
    return errorResponse('OAUTH_ACCOUNT_SUSPENDED', '此帳號已停用', 403);
  }

  // 5. 發我們自己的 authorization code，導回 client 註冊的 redirect_uri
  const ourCode = generateOpaqueToken(32);
  await new D1Adapter(db, 'AuthorizationCode').upsert(ourCode, {
    client_id: row.client_id,
    user_id: userId,
    // 第一方 client 沿用 routes/login.ts 的形狀（沒有 redirect_uri，兌換時也不可帶）
    redirect_uri: row.first_party ? null : row.redirect_uri,
    scopes: row.scopes,
    code_challenge: row.code_challenge ?? null,
    code_challenge_method: row.code_challenge_method ?? null,
    ...(row.dpop_jkt ? { dpop_jkt: row.dpop_jkt } : {}),
  }, row.first_party ? FIRST_PARTY_CODE_TTL_SEC : CODE_TTL_SEC);

  await recordAuthEvent(db, context.request, {
    eventType: 'login', outcome: 'success', userId, clientId: row.client_id, metadata: { provider: 'google' },
  }, context.env);

  return new Response(null, {
    status: 302,
    headers: { Location: buildClientRedirect(row.redirect_uri, { code: ourCode, state: row.client_state ?? null }), 'cache-control': 'no-store' },
  });
};
