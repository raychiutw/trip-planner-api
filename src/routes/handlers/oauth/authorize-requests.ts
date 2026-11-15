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
 *   （否則 403 OAUTH_REAUTH_ACCOUNT_MISMATCH，不發 code、請求已燒掉）；意圖只來自 App，intent 端點在此模式回 400。
 * - Consent 沿用舊 consent.ts：key = `${user}:${client}`、TTL 1 年、儲存驗過的 scopes。
 */
import { AppError, oauthErrorResponse } from '../../../errors';
import { MOBILE_GATE_MESSAGE, mobileClientAllowed } from '../../../lib/mobile-oauth';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { validateAuthorizeRequest, type ClientAppRow } from '../../../lib/oauth-server/validate-authorize-request';
import { buildClientRedirect, isBiometricIntent, takeOnce } from '../../../lib/oauth-single-use';
import { generateOpaqueToken, getAuth } from '../../../lib/utils';
import type { Env } from '../../../env';
import type { AuthRequestPayload } from './authorize';

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

/**
 * 這個 bearer 是否「剛用密碼登入」得到的：/api/oauth/login 簽的 code（redirect_uri 為 null、TTL 60 秒）
 * 在換成 token 後仍留在 oauth_models 到期，且 grantId 與 bearer 相同。refresh 還原的登入沿用舊 grantId，
 * 而該 code 早已過期被清，所以還原的舊登入通過不了。不需要 schema 變更。
 * 限制：登入後 60 秒內才能批准；超過要重新輸入密碼。
 */
async function isFreshPasswordLogin(db: D1Database, grantId: string | undefined): Promise<boolean> {
  if (!grantId) return false;
  const row = await db
    .prepare("SELECT 1 AS x FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.grantId') = ? AND json_extract(payload, '$.redirect_uri') IS NULL AND expires_at >= ?")
    .bind(grantId, Date.now())
    .first();
  return !!row;
}

async function loadClient(db: D1Database, clientId: string): Promise<ClientAppRow | null> {
  return db
    .prepare('SELECT client_id, client_type, app_name, redirect_uris, allowed_scopes, status FROM client_apps WHERE client_id = ?')
    .bind(clientId)
    .first<ClientAppRow>();
}

/** 以存下的參數重跑一次驗證（結果的 redirectUri 一定是 client 已註冊的）。失敗 → null。 */
function revalidate(req: AuthRequestPayload, client: ClientAppRow | null) {
  const result = validateAuthorizeRequest(
    {
      response_type: 'code',
      client_id: req.client_id,
      redirect_uri: req.redirect_uri,
      scope: req.scopes.join(' '),
      state: req.state ?? undefined,
      code_challenge: req.code_challenge ?? undefined,
      code_challenge_method: req.code_challenge_method ?? undefined,
      prompt: req.prompt ?? undefined,
    },
    client,
  );
  return 'code' in result ? null : result;
}

function isAuthRequest(p: unknown): p is AuthRequestPayload {
  const r = p as AuthRequestPayload | undefined;
  return !!r && typeof r.client_id === 'string' && typeof r.redirect_uri === 'string' && Array.isArray(r.scopes);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const userId = requireUserId(context);
  const id = (context.params as Record<string, string>).id ?? '';
  const stored = await new D1Adapter(context.env.DB, 'AuthRequest').findWithExpiry(id);
  if (!stored || !isAuthRequest(stored.payload)) throw invalidRequest();
  const req = stored.payload;
  const client = await loadClient(context.env.DB, req.client_id);
  if (!revalidate(req, client)) throw invalidRequest();

  const consent = (await new D1Adapter(context.env.DB, 'Consent').find(`${userId}:${req.client_id}`)) as { scopes?: string[] } | undefined;
  const needsConsent = req.prompt === 'consent' || !consent || !req.scopes.every((s) => consent.scopes?.includes(s));
  return new Response(JSON.stringify({
    client: { client_id: client!.client_id, app_name: client!.app_name },
    scopes: req.scopes,
    needs_consent: needsConsent,
    from_app: !!req.biometric_hint,
    biometric_hint: req.biometric_hint === 'faceid' || req.biometric_hint === 'touchid' ? req.biometric_hint : null,
    expires_at: new Date(stored.expiresAt).toISOString(),
  }), { headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });
};

/** 記下（或清掉）意圖。條件式 UPDATE：請求已被 approve／deny 搶佔刪除或過期就不會被復活。 */
export const onRequestPostIntent: PagesFunction<Env> = async (context) => {
  const userId = requireUserId(context);
  const id = (context.params as Record<string, string>).id ?? '';
  // 重新驗證模式的意圖由 App 在發起授權時決定，web 不能事後設定或覆寫
  const existing = await new D1Adapter(context.env.DB, 'AuthRequest').find(id);
  if (existing && (existing as AuthRequestPayload).reauth_intent) throw new AppError('DATA_VALIDATION', '重新驗證請求的意圖由 App 決定，不可變更');
  const body = (await context.request.json().catch(() => null)) as { intent?: unknown } | null;
  const intent = body?.intent;
  if (intent !== null && !isBiometricIntent(intent)) throw new AppError('DATA_VALIDATION', 'intent 必須是 enable、disable 或 null');
  const res = await context.env.DB
    .prepare("UPDATE oauth_models SET payload = json_set(payload, '$.intent', ?, '$.intent_user_id', ?) WHERE name = 'AuthRequest' AND id = ? AND expires_at >= ?")
    .bind(intent, intent === null ? null : userId, id, Date.now())
    .run();
  if ((res.meta?.changes ?? 0) !== 1) throw invalidRequest();
  return new Response(null, { status: 204, headers: NO_STORE });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const userId = requireUserId(context);
  const params = context.params as Record<string, string>;
  const decision = new URL(context.request.url).pathname.endsWith('/deny') ? 'deny' : 'approve';
  const { DB } = context.env;

  // 先搶佔刪除：贏家才繼續（單次使用）
  // 重新驗證模式：先確認這個 bearer 是剛用密碼登入的（不燒掉請求，讓使用者重新登入後可再批准）
  if (decision === 'approve') {
    const peek = (await new D1Adapter(DB, 'AuthRequest').find(params.id ?? '')) as AuthRequestPayload | undefined;
    if (peek?.reauth_intent && !(await isFreshPasswordLogin(DB, getAuth(context)?.grantId))) throw new AppError('OAUTH_REAUTH_REQUIRED');
  }

  const taken = await takeOnce(DB, 'AuthRequest', params.id ?? '');
  if (!taken || !isAuthRequest(taken)) throw invalidRequest();
  const req = taken;

  // mobile client 的環境閘門（取代舊 consent 的同一段）：在別的環境建立的 request 不能在這裡同意或拒絕
  if (!mobileClientAllowed(context.env, context.request, req.client_id, req.redirect_uri)) {
    return oauthErrorResponse('unauthorized_client', MOBILE_GATE_MESSAGE, 400);
  }

  const validated = revalidate(req, await loadClient(DB, req.client_id));
  if (!validated) throw invalidRequest(); // client 已停用或 redirect_uri 不再已註冊：不導向任何地方

  const reply = (redirectTo: string) =>
    new Response(JSON.stringify({ redirect_to: redirectTo }), { headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });

  if (decision === 'deny') {
    await recordAuthEvent(DB, context.request, {
      eventType: 'oauth_consent', outcome: 'failure', userId, clientId: validated.client.client_id, failureReason: 'access_denied',
    }, context.env);
    return reply(buildClientRedirect(validated.redirectUri, { error: 'access_denied', state: validated.state }));
  }

  // 重新驗證模式：批准者必須是 App 目前的帳號；不符就不發 code（請求已被搶佔，不可重試）
  if (req.reauth_intent && req.expected_account !== userId) {
    await recordAuthEvent(DB, context.request, {
      eventType: 'oauth_consent', outcome: 'failure', userId, clientId: validated.client.client_id, failureReason: 'reauth_account_mismatch',
    }, context.env);
    throw new AppError('OAUTH_REAUTH_ACCOUNT_MISMATCH');
  }

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
    // 旗標只由 server 依存下的意圖決定：重新驗證模式用 authorize 時已驗過的 reauth_intent；
    // 一般模式必須是白名單值，且設定者就是目前批准的使用者
    biometricIntent: req.reauth_intent
      ? req.reauth_intent
      : isBiometricIntent(req.intent) && req.intent_user_id === userId ? req.intent : undefined,
  }));
};
