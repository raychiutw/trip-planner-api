/** 導回 client 的網址組裝（授權請求的單次使用領取在 auth-request.ts）。 */
import { PARAM_BIOMETRIC_INTENT, type BiometricIntent } from './oauth-contract';

/** 把 code／error／state（與 server 決定的 biometric_intent）加到 redirect_uri 的 query（原有的 code／error 先清掉，其餘 query 保留）。 */
export function buildClientRedirect(
  redirectUri: string,
  params: { code?: string; error?: string; errorDescription?: string; state?: string | null; biometricIntent?: BiometricIntent },
): string {
  const url = new URL(redirectUri);
  url.searchParams.delete('code');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  url.searchParams.delete('state');
  url.searchParams.delete(PARAM_BIOMETRIC_INTENT);
  if (params.code) url.searchParams.set('code', params.code);
  if (params.error) url.searchParams.set('error', params.error);
  if (params.errorDescription) url.searchParams.set('error_description', params.errorDescription);
  if (params.state) url.searchParams.set('state', params.state);
  if (params.biometricIntent) url.searchParams.set(PARAM_BIOMETRIC_INTENT, params.biometricIntent);
  return url.toString();
}
