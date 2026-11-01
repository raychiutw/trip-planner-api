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
 *
 * 帳號刪除重新驗證分支（state 帶 `reauth`，由 login/google?purpose=account-delete 建立；自舊入口移植）：
 *   取得 id_token claims 後驗證 nonce、auth_time 夠新（不早於開始時間、不在未來、不超過 5 分鐘），
 *   並以唯讀查詢確認 Google sub 對應到同一個帳號。**不建 user／identity、不更新 last_used_at、不發 authorization code**，
 *   只把 mobile challenge 由 started 轉 verified，302 回 mobile callback（?challenge_id=…&status=verified）。
 *   任何失敗（含使用者取消、換 token 失敗）：challenge started→failed，302 回 ?challenge_id=…&status=failed；
 *   沒有可用 challenge 時回 JSON 403 ACCOUNT_DELETE_REAUTH_REQUIRED。
 */
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { verifyGoogleIdToken } from '../../../../lib/oauth-client/google-id-token';
import { recordAuthEvent } from '../../../../lib/auth-audit';
import { buildClientRedirect, takeOnce } from '../../../../lib/oauth-single-use';
import { generateOpaqueToken, getPublicOrigin } from '../../../../lib/utils';
import type { Env } from '../../../../env';
import { notConfigured } from '../login/google';
import { mobileOAuthContract } from '../../../../lib/mobile-oauth';
import {
  DELETE_PROOF_TTL_MS, readMobileDeleteChallenge, transitionMobileDeleteChallenge,
} from '../../../../lib/delete-reauth';

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
  created_at?: number;
  reauth?: { uid: string; challengeId: string; grantId: string; clientId: string };
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

/** 帳號刪除重新驗證的 callback（見檔頭）。所有失敗一律走 reauthFailure，成功只轉 challenge 狀態。 */
async function finishDeleteReauth(
  context: Parameters<PagesFunction<Env>>[0],
  row: GoogleLoginStatePayload,
  code: string | null,
  providerError: string | null,
  googleClientId: string,
  googleClientSecret: string,
): Promise<Response> {
  const reauth = row.reauth!;
  const db = context.env.DB;
  const contract = mobileOAuthContract(context.env, context.request);
  const reauthFailure = async (message: string, status = 403): Promise<Response> => {
    if (reauth.clientId === contract?.clientId) {
      await transitionMobileDeleteChallenge(db, reauth.challengeId, reauth.uid, reauth.grantId, 'started', 'failed');
      const redirect = new URL(row.redirect_uri!);
      redirect.searchParams.set('challenge_id', reauth.challengeId);
      redirect.searchParams.set('status', 'failed');
      return new Response(null, { status: 302, headers: { Location: redirect.toString(), 'cache-control': 'no-store' } });
    }
    return errorResponse('ACCOUNT_DELETE_REAUTH_REQUIRED', message, status);
  };

  if (providerError) return reauthFailure('Google 驗證未完成');
  if (!code) return reauthFailure('缺少授權碼');

  let tokenRes: Response;
  try {
    tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: `${getPublicOrigin(context.env, context.request)}/api/oauth/callback/google`,
        grant_type: 'authorization_code',
        code_verifier: row.google_code_verifier!,
      }),
    });
  } catch {
    return reauthFailure('Google 驗證暫時無法完成', 502);
  }
  if (!tokenRes.ok) return reauthFailure('Google 驗證失敗', 502);
  let tokenJson: GoogleTokenResponse;
  try { tokenJson = (await tokenRes.json()) as GoogleTokenResponse; } catch { return reauthFailure('Google 憑證無效', 502); }

  let claims;
  try {
    claims = await verifyGoogleIdToken(tokenJson.id_token, googleClientId);
  } catch {
    return reauthFailure('Google 憑證無效', 401);
  }
  if (claims['nonce'] !== row.nonce) return reauthFailure('Google 憑證無效', 401);
  const sub = claims.sub;
  if (!sub || typeof claims.email !== 'string' || !claims.email) return reauthFailure('Google 憑證缺少身分資訊');

  const authTime = claims['auth_time'];
  const startedAt = row.created_at ?? 0;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime) ||
      authTime * 1000 < startedAt - 5000 || authTime * 1000 > Date.now() + 5000 ||
      Date.now() - authTime * 1000 > DELETE_PROOF_TTL_MS) {
    return reauthFailure('請重新驗證身分');
  }
  const identity = await db.prepare('SELECT user_id FROM auth_identities WHERE provider = ? AND provider_user_id = ?')
    .bind('google', sub).first<{ user_id: string }>();
  if (identity?.user_id !== reauth.uid) return reauthFailure('驗證帳號不符');

  if (reauth.clientId !== contract?.clientId) return reauthFailure('請重新驗證身分');
  const challenge = await readMobileDeleteChallenge(db, reauth.challengeId);
  if (!challenge || challenge.uid !== identity.user_id || challenge.grantId !== reauth.grantId ||
      challenge.clientId !== reauth.clientId || challenge.expired ||
      !(await transitionMobileDeleteChallenge(db, reauth.challengeId, identity.user_id, challenge.grantId, 'started', 'verified'))) {
    return reauthFailure('請重新驗證身分');
  }
  const redirect = new URL(row.redirect_uri!);
  redirect.searchParams.set('challenge_id', reauth.challengeId);
  redirect.searchParams.set('status', 'verified');
  return new Response(null, { status: 302, headers: { Location: redirect.toString(), 'cache-control': 'no-store' } });
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

  if (row.reauth) return finishDeleteReauth(context, row, code, url.searchParams.get('error'), clientId, clientSecret);

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
