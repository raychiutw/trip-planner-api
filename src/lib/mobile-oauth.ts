/**
 * mobile OAuth 的環境契約（自舊入口 functions/api/_mobileOAuth.ts 移植）。
 *
 * 精確的 issuer／client／redirect 組合：不允許 wildcard host，也不跨環境 fallback。
 * 與舊入口的差異：preview 環境不再硬寫舊 web 的 UAT 網域，改成「請求 origin 必須等於明確設定的 PUBLIC_ORIGIN」
 * （新 api 的 staging 網域不在舊入口的白名單內；沒設 PUBLIC_ORIGIN 的 preview 一律不通過）。
 */
import { getPublicOrigin } from './utils';
import type { Env } from '../env';

export const MOBILE_CALLBACK_HOST = 'https://mobile-callback.trip-planner-dby.pages.dev';
export const MOBILE_PROD_REDIRECT = `${MOBILE_CALLBACK_HOST}/oauth/callback`;
export const MOBILE_UAT_REDIRECT = `${MOBILE_CALLBACK_HOST}/uat/oauth/callback`;
export const MOBILE_DEV_REDIRECT = 'http://127.0.0.1:8765';

export function mobileOAuthContract(env: Env, request: Request): { clientId: string; redirectUri: string } | null {
  const origin = new URL(request.url).origin;
  if (env.ENVIRONMENT === 'production' && origin === getPublicOrigin(env, request)) {
    return { clientId: 'tripline-mobile', redirectUri: MOBILE_PROD_REDIRECT };
  }
  if (env.ENVIRONMENT === 'preview' && env.PUBLIC_ORIGIN && origin === env.PUBLIC_ORIGIN.replace(/\/+$/, '')) {
    return { clientId: 'tripline-mobile-uat', redirectUri: MOBILE_UAT_REDIRECT };
  }
  if (env.ENVIRONMENT === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return { clientId: 'tripline-mobile-dev', redirectUri: MOBILE_DEV_REDIRECT };
  }
  return null;
}
