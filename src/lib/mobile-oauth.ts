/**
 * mobile OAuth 的環境契約（自舊入口 functions/api/_mobileOAuth.ts 移植）。
 *
 * 精確的 issuer／client／redirect 組合：不允許 wildcard host，也不跨環境 fallback。
 * 與舊入口的差異：preview 環境不再硬寫舊 web 的 UAT 網域，改成「請求 origin 必須等於明確設定的 PUBLIC_ORIGIN」
 * （新 api 的 staging 網域不在舊入口的白名單內；沒設 PUBLIC_ORIGIN 的 preview 一律不通過）。
 */
import { getPublicOrigin } from './utils';
import type { Env } from '../env';

// 新 callback：web 主站路徑（與 issuer 的 workers.dev 主機刻意不同；raychiutw/trip-planner#1482）。
export const MOBILE_CALLBACK_HOST = 'https://trip-planner-dby.pages.dev';
export const MOBILE_PROD_REDIRECT = `${MOBILE_CALLBACK_HOST}/mobile/oauth/callback`;
export const MOBILE_UAT_REDIRECT = `${MOBILE_CALLBACK_HOST}/mobile/uat/oauth/callback`;
// 舊 callback（mobile-callback 分支別名）：已發佈的 App 仍在用，過渡期必須繼續接受；刪除是另案。
export const MOBILE_LEGACY_CALLBACK_HOST = 'https://mobile-callback.trip-planner-dby.pages.dev';
export const MOBILE_LEGACY_PROD_REDIRECT = `${MOBILE_LEGACY_CALLBACK_HOST}/oauth/callback`;
export const MOBILE_LEGACY_UAT_REDIRECT = `${MOBILE_LEGACY_CALLBACK_HOST}/uat/oauth/callback`;
export const MOBILE_DEV_REDIRECT = 'http://127.0.0.1:8765';

/** redirectUri 是偏好（新）值；redirectUris 是該環境允許的精確集合（authorize／consent／token 以此比對）。 */
export function mobileOAuthContract(env: Env, request: Request): { clientId: string; redirectUri: string; redirectUris: readonly string[] } | null {
  const origin = new URL(request.url).origin;
  if (env.ENVIRONMENT === 'production' && origin === getPublicOrigin(env, request)) {
    return { clientId: 'tripline-mobile', redirectUri: MOBILE_PROD_REDIRECT, redirectUris: [MOBILE_PROD_REDIRECT, MOBILE_LEGACY_PROD_REDIRECT] };
  }
  if (env.ENVIRONMENT === 'preview' && env.PUBLIC_ORIGIN && origin === env.PUBLIC_ORIGIN.replace(/\/+$/, '')) {
    return { clientId: 'tripline-mobile-uat', redirectUri: MOBILE_UAT_REDIRECT, redirectUris: [MOBILE_UAT_REDIRECT, MOBILE_LEGACY_UAT_REDIRECT] };
  }
  if (env.ENVIRONMENT === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return { clientId: 'tripline-mobile-dev', redirectUri: MOBILE_DEV_REDIRECT, redirectUris: [MOBILE_DEV_REDIRECT] };
  }
  return null;
}

export function isMobileClientId(clientId: string): boolean {
  return clientId === 'tripline-mobile' || clientId === 'tripline-mobile-uat' || clientId === 'tripline-mobile-dev';
}

/**
 * authorize／approve／token 共用的環境閘門：mobile client 必須與環境相符，redirect_uri（有帶時）必須精確等於該環境允許集合內的某一個（過渡期新舊並存）。
 * 非 mobile client 恆為 true（不影響既有 client）。
 */
export function mobileClientAllowed(env: Env, request: Request, clientId: string, redirectUri?: string | null): boolean {
  if (!isMobileClientId(clientId)) return true;
  const contract = mobileOAuthContract(env, request);
  return !!contract && clientId === contract.clientId && (redirectUri === undefined || contract.redirectUris.includes(redirectUri ?? ''));
}

export const MOBILE_GATE_MESSAGE = 'Mobile client or callback is not allowed in this environment';
