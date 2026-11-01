/**
 * /api/account/ai-authorization — owner 就地授權 Tripline AI（tp-request pipeline）幫排自己的行程。
 *
 * Approach B（直接授權，非 OAuth redirect dance）：登入的 owner 就地建立
 * `${uid}:tripline-tp-request` 的 Consent grant；mint-restricted 靠此 grant 以 owner 身份簽發
 * 受限 token。**不需**在機器 client 上註冊 web redirect_uri、**不**簽發沒人消費的 auth code。
 * 用於「開啟新 trip」流程的就地授權卡（NewTripPage V1）。撤銷走既有
 * `DELETE /api/account/connected-apps/tripline-tp-request`（帳號設定 → 已連結應用）。
 *
 * GET  → { authorized: boolean }（目前 user 是否已授權 tp-request）
 * POST → 建立/更新 Consent（idempotent upsert），{ authorized: true }
 *
 * Auth: requireAccountUser（第一方 client 的 user-bound bearer）。**只授權固定的自家 AI client**（不吃外部 client_id 參數）
 *   → 無「授權任意 client」提權面。POST 的 CSRF 由 middleware checkCsrf 把關（Origin header
 *   allowlist；認證走 bearer，無 cookie 故無 CSRF 面）。
 */
import { requireAccountUser } from '../../../lib/account-user';
import { rawJson } from '../../../lib/utils';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import type { Env } from '../../../env';

// 唯一可經此端點授權的 client（Tripline 自家 AI 排程 pipeline，見 provision-tp-request-client）。
// 單一來源 —— 原本此處與另一檔各寫死一份。
import { TP_REQUEST_CLIENT_ID } from '../../../lib/first-party';
// 1yr（同 consent.ts）；user 可隨時於帳號設定撤銷。
const CONSENT_TTL_SEC = 365 * 24 * 60 * 60;
// ⚠️ scopes 對 tp-request 不具授權效力（authz-drift 警語）：mint-restricted 只查 Consent 是否
// 存在、不讀 scopes（見 mint-restricted.ts 內註解），真正能力 = owner user_id + restrict_trip
// gate（單一 trip 寫入）。這裡存 openid/profile 純為對齊 client 註冊的 allowed_scopes +
// connected-apps 顯示；未來若要用 scopes 收斂 tp-request 能力，須改 mint-restricted 而非只改這裡。
const CONSENT_SCOPES = ['openid', 'profile'];

const consentKey = (uid: string) => `${uid}:${TP_REQUEST_CLIENT_ID}`;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const consent = await new D1Adapter(context.env.DB, 'Consent').find(consentKey(session.uid));
  return rawJson({ authorized: Boolean(consent) });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  await new D1Adapter(context.env.DB, 'Consent').upsert(
    consentKey(session.uid),
    { user_id: session.uid, client_id: TP_REQUEST_CLIENT_ID, scopes: CONSENT_SCOPES, grantedAt: Date.now() },
    CONSENT_TTL_SEC,
  );
  await recordAuthEvent(
    context.env.DB,
    context.request,
    {
      eventType: 'oauth_consent',
      outcome: 'success',
      userId: session.uid,
      clientId: TP_REQUEST_CLIENT_ID,
      metadata: { scopes: CONSENT_SCOPES, decision: 'allow', via: 'ai-authorization' },
    },
    context.env,
  );
  return rawJson({ authorized: true });
};
