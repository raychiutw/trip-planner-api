/**
 * 重新驗證（step-up）發證（spec trip-planner#1677、ADR-0016，票 api#81），已登入者呼叫：
 *   POST /api/account/reauth/options   發出 step-up 專用挑戰（綁定本人與目前 grant）
 *   POST /api/account/reauth/passkey   驗證 assertion，成功回 step-up 證明
 *   POST /api/account/reauth/password  沒有 passkey 的人用目前密碼換證明
 * 證明的內容、綁定與驗證函式見 lib/step-up。本票不掛在任何敏感端點上（#82）。
 *
 * 安全重點：
 * - assertion 的驗證規則與 passkey 登入相同（重用 verifyAssertion／advanceSignCount），另外憑證必須屬於「目前登入的使用者」。
 * - 挑戰以 takeOnce 單次領取且先於其他檢查；用途（passkey-stepup）、使用者、grant 都要對上，登入／註冊挑戰不能拿來用。
 * - 所有驗證失敗對外都是同一個 403 REAUTH_INVALID（刻意不用 401，避免 client 當成登入過期而清掉憑證），原因只寫 audit。
 * - 限流以使用者為單位、passkey 與密碼共用同一把鎖：只計失敗、成功清零，沿用 LOGIN 政策（第 6 次錯才上鎖）。
 */
import { requireAccountUser, type AccountUser } from '../../../lib/account-user';
import { AppError, buildRateLimitResponse, errorResponse } from '../../../errors';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { generateOpaqueToken } from '../../../lib/crypto';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { takeOnce } from '../../../lib/oauth-single-use';
import {
  advanceSignCount, parseClientData, passkeyRp, PASSKEY_CHALLENGE_MODEL, PASSKEY_CHALLENGE_TTL_SECONDS, PasskeyAssertionError, verifyAssertion,
} from '../../../lib/passkey';
import { verifyPassword } from '../../../lib/password';
import { bumpRateLimit, checkRateLimit, RATE_LIMITS, resetRateLimit } from '../../../lib/rate-limit';
import { recordSecurityEvent } from '../../../lib/security-events';
import { issueStepUpProof, requireGrantId, STEP_UP_PROOF_TTL_SECONDS, type StepUpMethod } from '../../../lib/step-up';
import { parseJsonBody } from '../../../lib/utils';
import type { Env } from '../../../env';

const PURPOSE = 'passkey-stepup';
const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: NO_STORE });
const limited = (retryAfter: number) =>
  buildRateLimitResponse(retryAfter, { error: { code: 'REAUTH_RATE_LIMITED', message: '嘗試次數過多，請稍後再試' } });

export const onRequestPostOptions: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const grantId = requireGrantId(user);
  const { env } = context;
  const gate = await bumpRateLimit(env.DB, `reauth-options:${user.uid}`, RATE_LIMITS.LOGIN_IP);
  if (!gate.ok) return limited(gate.retryAfter ?? 60);

  const challenge = generateOpaqueToken(32);
  await new D1Adapter(env.DB, PASSKEY_CHALLENGE_MODEL).upsert(challenge, { user_id: user.uid, grant_id: grantId, purpose: PURPOSE }, PASSKEY_CHALLENGE_TTL_SECONDS);
  const creds = await env.DB.prepare('SELECT id, transports FROM passkey_credentials WHERE user_id = ?').bind(user.uid).all<{ id: string; transports: string | null }>();
  return json({
    challenge,
    rpId: passkeyRp(env).id,
    timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
    userVerification: 'required',
    allowCredentials: creds.results.map((c) => ({ type: 'public-key', id: c.id, ...(c.transports ? { transports: JSON.parse(c.transports) } : {}) })),
  });
};

/** 共用：先看鎖、失敗時記 audit＋計數（第 6 次起回 429）、成功時清零並發證明。 */
function guard(context: { env: Env; request: Request }, user: AccountUser, method: StepUpMethod) {
  const { env, request } = context;
  const limitKey = `reauth:${user.uid}`;
  const audit = (outcome: 'success' | 'failure', failureReason?: string) =>
    recordAuthEvent(env.DB, request, { eventType: 'reauth', outcome, userId: user.uid, failureReason, metadata: { method } }, env);
  return {
    async locked(): Promise<Response | null> {
      const check = await checkRateLimit(env.DB, limitKey, RATE_LIMITS.LOGIN);
      if (check.ok) return null;
      await audit('failure', 'rate_limited');
      return limited(check.retryAfter ?? 60);
    },
    async fail(reason: string): Promise<Response> {
      await audit('failure', `${method}_${reason}`);
      const bumped = await bumpRateLimit(env.DB, limitKey, RATE_LIMITS.LOGIN);
      return bumped.ok ? errorResponse(new AppError('REAUTH_INVALID')) : limited(bumped.retryAfter ?? 60);
    },
    async succeed(): Promise<Response> {
      await resetRateLimit(env.DB, limitKey);
      const proof = await issueStepUpProof(env.DB, user, method);
      await audit('success');
      return json({ proof, expires_in: STEP_UP_PROOF_TTL_SECONDS });
    },
  };
}

interface PasskeyBody { credential?: { id?: unknown; response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown } } }

export const onRequestPostPasskey: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const grantId = requireGrantId(user);
  const { env, request } = context;
  const g = guard(context, user, 'passkey');
  const lockedRes = await g.locked();
  if (lockedRes) return lockedRes;

  let body: PasskeyBody | null = null;
  try { body = await parseJsonBody<PasskeyBody>(request); } catch { /* 下面統一當 malformed */ }
  const cred = body?.credential;
  const r = cred?.response;
  if (typeof cred?.id !== 'string' || typeof r?.clientDataJSON !== 'string' || typeof r.authenticatorData !== 'string' || typeof r.signature !== 'string') {
    return g.fail('malformed');
  }

  try {
    const clientData = parseClientData(r.clientDataJSON);
    // 挑戰先領（單次使用）：之後不論哪一步失敗，這個挑戰都已作廢
    const taken = await takeOnce(env.DB, PASSKEY_CHALLENGE_MODEL, clientData.challenge);
    if (!taken || taken.purpose !== PURPOSE || taken.user_id !== user.uid || taken.grant_id !== grantId) return await g.fail('challenge_invalid');

    // 憑證必須屬於目前登入的使用者；他人的憑證與不存在的憑證不可分辨
    const row = await env.DB.prepare('SELECT public_key, sign_count FROM passkey_credentials WHERE id = ? AND user_id = ?')
      .bind(cred.id, user.uid).first<{ public_key: string; sign_count: number }>();
    if (!row) return await g.fail('unknown_credential');

    const { signCount } = await verifyAssertion(
      { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, publicKey: row.public_key },
      passkeyRp(env),
    );
    const advanced = await advanceSignCount(env.DB, cred.id, row.sign_count, signCount);
    if (advanced === 'regression') {
      await recordSecurityEvent(env, request, { kind: 'signature_error', reason: 'stepup_sign_count_regression', userId: user.uid, clientId: user.auth.clientId });
      return await g.fail('sign_count_regression');
    }
    if (advanced === 'race') return await g.fail('sign_count_race');
  } catch (err) {
    if (err instanceof PasskeyAssertionError) return g.fail(err.reason);
    if (err instanceof AppError) return g.fail('malformed');
    throw err;
  }
  return g.succeed();
};

export const onRequestPostPassword: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  requireGrantId(user);
  const { env, request } = context;
  const g = guard(context, user, 'password');
  const lockedRes = await g.locked();
  if (lockedRes) return lockedRes;

  let body: { password?: unknown } | null = null;
  try { body = await parseJsonBody<{ password?: unknown }>(request); } catch { /* 當作沒帶密碼 */ }
  const password = typeof body?.password === 'string' ? body.password : '';

  const identity = await env.DB
    .prepare(`SELECT password_hash FROM auth_identities WHERE user_id = ? AND provider = 'local' AND password_hash IS NOT NULL`)
    .bind(user.uid).first<{ password_hash: string }>();
  if (!identity) {
    await recordAuthEvent(env.DB, request, { eventType: 'reauth', outcome: 'failure', userId: user.uid, failureReason: 'password_no_password', metadata: { method: 'password' } }, env);
    throw new AppError('REAUTH_NO_PASSWORD');
  }
  if (!password || !(await verifyPassword(password, identity.password_hash))) return g.fail('invalid');
  return g.succeed();
};
