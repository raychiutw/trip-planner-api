/**
 * passkey 註冊（spec trip-planner#1677、ADR-0016），兩步：
 *   POST /api/account/passkeys/register/options  發出一次性、短時效、綁定使用者的挑戰，回 WebAuthn 建立選項
 *   POST /api/account/passkeys/register/verify   驗證瀏覽器／App 回傳的憑證後儲存，並寄通知信
 *
 * 挑戰存在 oauth_models（name = PasskeyChallenge），以 takeOnce 領取：只有一個呼叫者拿得到，重放與逾期一律失敗。
 * 通知信沿用變更密碼的做法：事後通知，寄信失敗只記錄與告警，不影響註冊結果。
 */
import { requireAccountUser } from '../../../../lib/account-user';
import { AppError } from '../../../../errors';
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { takeOnce } from '../../../../lib/oauth-single-use';
import { generateOpaqueToken } from '../../../../lib/crypto';
import { recordAuthEvent } from '../../../../lib/auth-audit';
import { recordEmailEvent } from '../../../../lib/audit';
import { sendEmail, EmailError } from '../../../../lib/email';
import { alertAdminTelegram } from '../../../../lib/alert';
import { maskEmail } from '../../../../lib/pii';
import { passkeyAddedNotice } from '../../../../lib/email-templates';
import { parseJsonBody, rawJson } from '../../../../lib/utils';
import {
  PASSKEY_CHALLENGE_MODEL, PASSKEY_CHALLENGE_TTL_SECONDS, PasskeyError,
  b64uEncode, parseClientData, passkeyRp, verifyRegistration,
} from '../../../../lib/passkey';
import type { Env } from '../../../../env';

const PURPOSE = 'passkey-register';
const NAME_MAX = 50;
const DEFAULT_NAME = 'Passkey';

export const onRequestPostOptions: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const { env } = context;
  const rp = passkeyRp(env);

  const challenge = generateOpaqueToken(32);
  await new D1Adapter(env.DB, PASSKEY_CHALLENGE_MODEL).upsert(challenge, { user_id: user.uid, purpose: PURPOSE }, PASSKEY_CHALLENGE_TTL_SECONDS);

  const [profile, existing] = await Promise.all([
    env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(user.uid).first<{ display_name: string | null }>(),
    env.DB.prepare('SELECT id, transports FROM passkey_credentials WHERE user_id = ?').bind(user.uid).all<{ id: string; transports: string | null }>(),
  ]);
  return rawJson({
    challenge,
    rp: { id: rp.id, name: 'Tripline' },
    user: { id: b64uEncode(new TextEncoder().encode(user.uid)), name: user.email, displayName: profile?.display_name || user.email },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.results.map((c) => ({ type: 'public-key', id: c.id, ...(c.transports ? { transports: JSON.parse(c.transports) } : {}) })),
  });
};

interface VerifyBody {
  name?: unknown;
  credential?: { id?: unknown; response?: { clientDataJSON?: unknown; attestationObject?: unknown; transports?: unknown } };
}

export const onRequestPostVerify: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const { env, request } = context;
  const audit = (outcome: 'success' | 'failure', failureReason?: string) =>
    recordAuthEvent(env.DB, request, { eventType: 'passkey_register', outcome, userId: user.uid, failureReason }, env);

  try {
    const body = (await parseJsonBody<VerifyBody>(request)) ?? {};
    const cred = body.credential;
    const credentialId = cred?.id;
    const clientDataJSON = cred?.response?.clientDataJSON;
    const attestationObject = cred?.response?.attestationObject;
    if (typeof credentialId !== 'string' || typeof clientDataJSON !== 'string' || typeof attestationObject !== 'string') {
      throw new PasskeyError('malformed', '缺少憑證欄位');
    }
    const clientData = parseClientData(clientDataJSON);

    // 挑戰先領（單次使用）：之後不論哪一步失敗，這個挑戰都已作廢，必須重新開始。
    const taken = await takeOnce(env.DB, PASSKEY_CHALLENGE_MODEL, clientData.challenge);
    if (!taken || taken.purpose !== PURPOSE || taken.user_id !== user.uid) throw new AppError('PASSKEY_CHALLENGE_INVALID');

    const verified = await verifyRegistration({ credentialId, clientData, attestationObject }, passkeyRp(env));

    const transports = Array.isArray(cred?.response?.transports)
      ? (cred!.response!.transports as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 8)
      : [];
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, NAME_MAX) : DEFAULT_NAME;

    const insert = await env.DB
      .prepare(`INSERT OR IGNORE INTO passkey_credentials (id, user_id, public_key, alg, sign_count, name, transports, backup_eligible, backed_up, aaguid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(verified.credentialId, user.uid, verified.publicKey, verified.alg, verified.signCount, name,
        transports.length ? JSON.stringify(transports) : null, verified.backupEligible ? 1 : 0, verified.backedUp ? 1 : 0, verified.aaguid)
      .run();
    if ((insert.meta?.changes ?? 0) !== 1) throw new AppError('PASSKEY_ALREADY_REGISTERED');

    const row = await env.DB.prepare('SELECT created_at FROM passkey_credentials WHERE id = ?').bind(verified.credentialId).first<{ created_at: string }>();
    await audit('success');
    try {
      await sendNotice(env, user.email, user.uid, name);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[passkey-register] notice failed:', (err as Error).message);
    }
    return rawJson({ id: verified.credentialId, name, transports, backupEligible: verified.backupEligible, createdAt: row?.created_at ?? null }, 201);
  } catch (err) {
    if (err instanceof AppError) await audit('failure', err instanceof PasskeyError ? err.reason : err.code.toLowerCase().replace(/^passkey_/, ''));
    throw err;
  }
};

/** 通知信：事後通知，失敗只記錄與告警，不影響回應。 */
async function sendNotice(env: Env, email: string, userId: string, passkeyName: string): Promise<void> {
  const row = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first<{ display_name: string | null }>();
  const tpl = passkeyAddedNotice(row?.display_name ?? null, passkeyName);
  try {
    const result = await sendEmail(env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, template: 'passkey-added' });
    await recordEmailEvent(env.DB, { template: 'passkey-added', recipient: email, status: 'sent', latencyMs: result.elapsed, triggeredBy: email });
  } catch (err) {
    const msg = err instanceof EmailError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
    await recordEmailEvent(env.DB, { template: 'passkey-added', recipient: email, status: 'failed', error: msg, triggeredBy: email });
    await alertAdminTelegram(env, `新增 passkey 通知信寄送失敗（passkey 已新增）: ${maskEmail(email)} (${msg})`);
  }
}
