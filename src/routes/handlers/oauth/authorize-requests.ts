/**
 * 授權請求的 JSON 端點（同意畫面由 web 呈現；這裡只提供資料與決定）。
 *
 *   GET  /api/oauth/authorize/requests/:id          → 顯示用資料（client 名稱、scope、是否已同意過）
 *   POST /api/oauth/authorize/requests/:id/approve  → 寫入 Consent、產生 authorization code，回 { redirect_to }
 *   POST /api/oauth/authorize/requests/:id/deny     → 回帶 error=access_denied 與 state 的 { redirect_to }
 *   POST /api/oauth/authorize/requests/:id/intent   → body { intent: 'enable'|'disable'|null }，記下生物辨識意圖（204）
 *
 * 安全重點：
 * - 一律要 bearer 使用者（service token 沒有使用者身份 → 403）。
 * - AuthRequest 只在 TTL 內有效；approve／deny 先「搶佔刪除」再做事，所以單次使用（重放、平行重送只有一個贏家）。
 * - redirect_to 一律由 server 端存的、已驗過的 redirect_uri 組成；不收任何由 web 傳入的 URL 或參數。
 *   approve 時再驗一次 client（仍啟用、redirect_uri 仍已註冊），避免授權請求建立後 client 被停用或改註冊。
 * - 意圖只綁定設定它的使用者；approve 時只有同一位使用者才會讓 server 在 redirect_to 加 biometric_intent 旗標（值只來自白名單）。
 * - 重新驗證模式（AuthRequest 有 reauth_intent，由 App 以 prompt=login + biometric_intent + expected_account 發起）：
 *   approve 要求 bearer 是剛用密碼登入的（否則 403 OAUTH_REAUTH_REQUIRED，請求保留可重試）、且使用者就是 expected_account
 *   （否則比照 deny：200 redirect_to 帶 error=reauth_account_mismatch，不發 code、請求已燒掉）；意圖只來自 App，intent 端點在此模式回 400。
 * - 單獨 prompt=login（沒有意圖）同樣要求剛密碼登入，但沒有 expected_account，不比對帳號。
 * - Consent 沿用舊 consent.ts：key = `${user}:${client}`、TTL 1 年、儲存驗過的 scopes。
 */
import { AppError, oauthErrorResponse } from '../../../errors';
import { MOBILE_GATE_MESSAGE, mobileClientAllowed } from '../../../lib/mobile-oauth';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { loadClientApp, revalidateStoredRequest } from '../../../lib/oauth-server/validate-authorize-request';
import { decideApproval, requiresFreshLogin } from '../../../lib/oauth-server/approve-decision';
import { isFreshPasswordLogin } from '../../../lib/oauth-server/fresh-login';
import { peekAuthRequest, setAuthRequestIntent, takeAuthRequest } from '../../../lib/auth-request';
import { REAUTH_ACCOUNT_MISMATCH, isBiometricButtonHint } from '../../../lib/oauth-contract';
import { buildClientRedirect } from '../../../lib/oauth-redirect';
import { generateOpaqueToken, getAuth } from '../../../lib/utils';
import type { Env } from '../../../env';

const CODE_TTL_SEC = 10 * 60; // RFC 6749 §4.1.2 建議短效
const CONSENT_TTL_SEC = 365 * 24 * 60 * 60; // 1 年；使用者在帳號設定手動撤銷
const NO_STORE = { 'cache-control': 'no-store' };

const invalidRequest = () => new AppError('DATA_VALIDATION', '授權請求不存在、已過期或已使用');

function requireUserId(context: { data: unknown }): string {
  const auth = getAuth(context);
  if (!auth) throw new AppError('AUTH_REQUIRED');
  if (!auth.userId) throw new AppError('PERM_DENIED', '授權需要使用者身份');
  return auth.userId;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = requireUserId(context);
  const id = (context.params as Record<string, string>).id ?? '';
  const stored = await peekAuthRequest(context.env.DB, id);
  if (!stored) throw invalidRequest();
  const req = stored.payload;
  const client = await loadClientApp(context.env.DB, req.client_id);
  if (!revalidateStoredRequest(req, client)) throw invalidRequest();

  const consent = (await new D1Adapter(context.env.DB, 'Consent').find(`${userId}:${req.client_id}`)) as { scopes?: string[] } | undefined;
  const needsConsent = req.prompt === 'consent' || !consent || !req.scopes.every((s) => consent.scopes?.includes(s));
  return new Response(JSON.stringify({
    client: { client_id: client!.client_id, app_name: client!.app_name },
    scopes: req.scopes,
    needs_consent: needsConsent,
    from_app: !!req.biometric_hint,
    biometric_hint: isBiometricButtonHint(req.biometric_hint) ? req.biometric_hint : null,
    expires_at: new Date(stored.expiresAt).toISOString(),
  }), { headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });
};

/** 記下（或清掉）意圖。條件式 UPDATE：請求已被 approve／deny 搶佔刪除或過期就不會被復活。 */
export const onRequestPostIntent: PagesFunction<Env> = async (context) => {
  const userId = requireUserId(context);
  const id = (context.params as Record<string, string>).id ?? '';
  const body = (await context.request.json().catch(() => null)) as { intent?: unknown } | null;
  const result = await setAuthRequestIntent(context.env.DB, id, body?.intent, userId);
  if (result === 'reauth') throw new AppError('DATA_VALIDATION', '重新驗證請求的意圖由 App 決定，不可變更');
  if (result === 'invalid_intent') throw new AppError('DATA_VALIDATION', 'intent 必須是 enable、disable 或 null');
  if (result === 'gone') throw invalidRequest();
  return new Response(null, { status: 204, headers: NO_STORE });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const userId = requireUserId(context);
  const params = context.params as Record<string, string>;
  const decision = new URL(context.request.url).pathname.endsWith('/deny') ? 'deny' : 'approve';
  const { DB } = context.env;

  // 重新驗證模式與單獨 prompt=login 要求剛密碼登入：先確認，不燒掉請求，讓使用者重新登入後可再批准
  const peeked = decision === 'approve' ? (await peekAuthRequest(DB, params.id ?? ''))?.payload : undefined;
  // 不需要新鮮度（一般授權、deny、請求已不存在）時視為通過，不查資料庫
  const freshLogin = peeked && requiresFreshLogin(peeked) ? await isFreshPasswordLogin(DB, getAuth(context)?.grantId) : true;
  if (peeked && decideApproval({ decision, req: peeked, userId, freshLogin }).kind === 'reauth_required') throw new AppError('OAUTH_REAUTH_REQUIRED');

  // 先搶佔刪除：贏家才繼續（單次使用）
  const req = await takeAuthRequest(DB, params.id ?? '');
  if (!req) throw invalidRequest();

  // mobile client 的環境閘門（取代舊 consent 的同一段）：在別的環境建立的 request 不能在這裡同意或拒絕
  if (!mobileClientAllowed(context.env, context.request, req.client_id, req.redirect_uri)) {
    return oauthErrorResponse('unauthorized_client', MOBILE_GATE_MESSAGE, 400);
  }

  const validated = revalidateStoredRequest(req, await loadClientApp(DB, req.client_id));
  if (!validated) throw invalidRequest(); // client 已停用或 redirect_uri 不再已註冊：不導向任何地方

  const reply = (redirectTo: string) =>
    new Response(JSON.stringify({ redirect_to: redirectTo }), { headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });

  const outcome = decideApproval({ decision, req, userId, freshLogin });

  if (outcome.kind === 'deny') {
    await recordAuthEvent(DB, context.request, {
      eventType: 'oauth_consent', outcome: 'failure', userId, clientId: validated.client.client_id, failureReason: 'access_denied',
    }, context.env);
    return reply(buildClientRedirect(validated.redirectUri, { error: 'access_denied', state: validated.state }));
  }

  // 重新驗證模式：批准者必須是 App 目前的帳號；不符就不發 code、不寫同意（請求已被搶佔，不可重試），
  // 但比照 deny 回 200 導回 App（error=reauth_account_mismatch），App 才收得到 callback 並提示
  if (outcome.kind === 'account_mismatch') {
    await recordAuthEvent(DB, context.request, {
      eventType: 'oauth_consent', outcome: 'failure', userId, clientId: validated.client.client_id, failureReason: REAUTH_ACCOUNT_MISMATCH,
    }, context.env);
    return reply(buildClientRedirect(validated.redirectUri, { error: REAUTH_ACCOUNT_MISMATCH, state: validated.state }));
  }
  // reauth_required 已在搶佔前攔下（同一個 freshLogin、同一份請求），正常走不到；保留作為型別收斂與 fail-closed 防線
  if (outcome.kind !== 'approve') throw new AppError('OAUTH_REAUTH_REQUIRED');

  // approve：寫入同意（驗過的 scopes，同 key 覆寫）→ 發 authorization code
  await new D1Adapter(DB, 'Consent').upsert(
    `${userId}:${validated.client.client_id}`,
    { user_id: userId, client_id: validated.client.client_id, scopes: validated.scopes, grantedAt: Date.now() },
    CONSENT_TTL_SEC,
  );
  await recordAuthEvent(DB, context.request, {
    eventType: 'oauth_consent', outcome: 'success', userId, clientId: validated.client.client_id,
    metadata: { scopes: validated.scopes, decision: 'allow' },
  }, context.env);

  const code = generateOpaqueToken();
  await new D1Adapter(DB, 'AuthorizationCode').upsert(code, {
    client_id: validated.client.client_id,
    user_id: userId,
    redirect_uri: validated.redirectUri,
    scopes: validated.scopes,
    code_challenge: validated.codeChallenge,
    code_challenge_method: validated.codeChallengeMethod,
  }, CODE_TTL_SEC);
  await recordAuthEvent(DB, context.request, {
    eventType: 'oauth_authorize', outcome: 'success', userId, clientId: validated.client.client_id,
    metadata: { scopes: validated.scopes, redirect_uri: validated.redirectUri },
  }, context.env);

  return reply(buildClientRedirect(validated.redirectUri, {
    code, state: validated.state,
    biometricIntent: outcome.biometricIntent, // 旗標只由 server 依存下的意圖決定（見 approve-decision）
  }));
};
