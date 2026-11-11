/**
 * passkey 登入（spec trip-planner#1677、ADR-0016），未登入可呼叫，兩步：
 *   POST /api/oauth/passkey/options  發出一次性、短時效的登入挑戰（不綁使用者：discoverable credential，allowCredentials 為空）
 *   POST /api/oauth/passkey/login    驗證 assertion；成功回 code，簽發走與密碼登入同一條路徑（lib/first-party-login），之後到 token endpoint 兌換
 *
 * 安全重點：
 * - 所有「驗證失敗」（未知憑證、他人憑證、簽名錯、旗標缺、網域錯、挑戰無效、停權、計數倒退）對外都是同一個 401 PASSKEY_LOGIN_INVALID，
 *   原因只寫 auth_audit_log；不洩漏帳號是否存在 passkey。
 * - 挑戰以 takeOnce 單次領取，且先於其他檢查：驗證失敗的挑戰也已作廢。
 * - 簽名計數不遞增（兩邊皆 0 的同步型 passkey 除外）視為複製的憑證：拒絕、不更新，並記 signature_error 安全事件（會告警）。
 * - 限流：以 IP 為單位（驗證前先保留一次嘗試、成功退還），沿用 LOGIN_IP 門檻；挑戰端點另有獨立的 IP 計數。
 * shortcut: 未知憑證不做假的 ECDSA 驗證，與「已知但驗證失敗」有微小的耗時差；要抗 timing 時補一把假金鑰驗一次。
 */
import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { AppError, buildRateLimitResponse, errorResponse } from '../errors';
import { recordAuthEvent } from '../lib/auth-audit';
import { generateOpaqueToken } from '../lib/crypto';
import { issueLoginCode, LOGIN_CODE_TTL_SEC, parseGrantShape, resolveFirstPartyGrant } from '../lib/first-party-login';
import { D1Adapter } from '../lib/oauth-d1-adapter';
import { readJsonObject } from '../lib/oauth-request';
import { takeOnce } from '../lib/oauth-single-use';
import {
  b64uEncode, parseClientData, passkeyRp, PASSKEY_CHALLENGE_MODEL, PASSKEY_CHALLENGE_TTL_SECONDS, PasskeyAssertionError, verifyAssertion,
} from '../lib/passkey';
import { bumpRateLimit, clientIp, RATE_LIMITS, refundRateLimit } from '../lib/rate-limit';
import { recordSecurityEvent } from '../lib/security-events';

const PURPOSE = 'passkey-login';

const invalidInput = () => errorResponse(new AppError('LOGIN_INVALID_INPUT'));
const rateLimited = (retryAfter: number) =>
  buildRateLimitResponse(retryAfter, { error: { code: 'LOGIN_RATE_LIMITED', message: '登入嘗試過多，請稍後再試' } });

interface CredRow { user_id: string; public_key: string; sign_count: number; status: string }

export function registerPasskeyLoginRoutes(app: Hono<AppEnv>): void {
  app.post('/api/oauth/passkey/options', async (c) => {
    const { DB } = c.env;
    const gate = await bumpRateLimit(DB, `passkey-options:${clientIp(c.req.raw)}`, RATE_LIMITS.LOGIN_IP);
    if (!gate.ok) return rateLimited(gate.retryAfter ?? 60);
    const challenge = generateOpaqueToken(32);
    await new D1Adapter(DB, PASSKEY_CHALLENGE_MODEL).upsert(challenge, { purpose: PURPOSE }, PASSKEY_CHALLENGE_TTL_SECONDS);
    return c.json({
      challenge,
      rpId: passkeyRp(c.env).id,
      timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
      userVerification: 'required',
      allowCredentials: [],
    }, 200, { 'Cache-Control': 'no-store' });
  });

  app.post('/api/oauth/passkey/login', async (c) => {
    const { DB } = c.env;
    const request = c.req.raw;

    const body = await readJsonObject(request);
    if (!body) return invalidInput();
    const cred = body.credential as { id?: unknown; response?: Record<string, unknown> } | undefined;
    const r = cred?.response;
    if (typeof body.client_id !== 'string' || typeof cred?.id !== 'string' || !r
      || typeof r.clientDataJSON !== 'string' || typeof r.authenticatorData !== 'string' || typeof r.signature !== 'string'
      || (r.userHandle !== undefined && r.userHandle !== null && typeof r.userHandle !== 'string')) return invalidInput();
    const shape = parseGrantShape(body);
    if (!shape) return invalidInput();
    const grant = await resolveFirstPartyGrant(DB, body.client_id, shape);
    if (!grant) return invalidInput();
    const clientId = grant.clientId;

    // 限流：驗證前先保留一次嘗試，成功才退還（淨失敗數）
    const ipKey = `passkey-login:${clientIp(request)}`;
    const reserved = await bumpRateLimit(DB, ipKey, RATE_LIMITS.LOGIN_IP);
    if (!reserved.ok) {
      await recordSecurityEvent(c.env, request, { kind: 'rate_limited', reason: 'passkey_ip_locked', clientId });
      return rateLimited(reserved.retryAfter ?? 60);
    }

    let userId: string | null = null;
    const fail = async (reason: string) => {
      await recordAuthEvent(DB, request, {
        eventType: 'login', outcome: 'failure', userId, clientId, failureReason: `passkey_${reason}`, metadata: { method: 'passkey' },
      }, c.env);
      return errorResponse(new AppError('PASSKEY_LOGIN_INVALID'));
    };

    try {
      const clientData = parseClientData(r.clientDataJSON);
      // 挑戰先領（單次使用）：之後不論哪一步失敗，這個挑戰都已作廢
      const taken = await takeOnce(DB, PASSKEY_CHALLENGE_MODEL, clientData.challenge);
      if (!taken || taken.purpose !== PURPOSE) return await fail('challenge_invalid');

      const row = await DB.prepare(
        `SELECT pc.user_id, pc.public_key, pc.sign_count, u.status
           FROM passkey_credentials pc JOIN users u ON u.id = pc.user_id WHERE pc.id = ?`,
      ).bind(cred.id).first<CredRow>();
      if (!row) return await fail('unknown_credential');
      userId = row.user_id;
      if (typeof r.userHandle === 'string' && r.userHandle !== b64uEncode(new TextEncoder().encode(row.user_id))) return await fail('user_mismatch');

      const { signCount } = await verifyAssertion(
        { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, publicKey: row.public_key },
        passkeyRp(c.env),
      );
      if (row.status !== 'active') return await fail('account_suspended');

      // 兩邊都是 0（同步型 passkey 不回報計數）可過；否則必須嚴格遞增，不然視為憑證被複製
      if ((row.sign_count > 0 || signCount > 0) && signCount <= row.sign_count) {
        await recordSecurityEvent(c.env, request, { kind: 'signature_error', reason: 'passkey_sign_count_regression', userId, clientId });
        return await fail('sign_count_regression');
      }
      // 條件式更新：同一個憑證併發登入時，只有一個贏家
      const upd = await DB.prepare("UPDATE passkey_credentials SET sign_count = ?, last_used_at = datetime('now') WHERE id = ? AND sign_count = ?")
        .bind(signCount, cred.id, row.sign_count).run();
      if ((upd.meta?.changes ?? 0) !== 1) return await fail('sign_count_race');
    } catch (err) {
      if (err instanceof PasskeyAssertionError) return await fail(err.reason);
      if (err instanceof AppError) return await fail('malformed');
      throw err;
    }

    await refundRateLimit(DB, ipKey);
    const code = await issueLoginCode(DB, userId!, grant);
    await recordAuthEvent(DB, request, { eventType: 'login', outcome: 'success', userId, clientId, metadata: { method: 'passkey' } }, c.env);
    return c.json({ code, expires_in: LOGIN_CODE_TTL_SEC }, 200, { 'Cache-Control': 'no-store' });
  });
}
