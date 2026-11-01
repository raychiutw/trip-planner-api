/**
 * Shared validator for `redirect_uris` array submitted to /api/dev/apps (POST/PATCH).
 *
 * Rules (matches autoplan §V2-P4):
 *   - 1..10 entries
 *   - each is a parseable URL
 *   - https only, except http://localhost / http://127.0.0.1 for dev clients
 *
 * Throws AppError('DATA_VALIDATION') so caller can let the framework's error
 * handler turn it into a 400 JSON response.
 */
import { AppError } from '../../errors';

export const REDIRECT_URIS_MAX = 10;

export function validateRedirectUris(uris: unknown): string[] {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new AppError('DATA_VALIDATION', 'redirect_uris 必填且至少 1 個');
  }
  if (uris.length > REDIRECT_URIS_MAX) {
    throw new AppError('DATA_VALIDATION', `redirect_uris 最多 ${REDIRECT_URIS_MAX} 個`);
  }
  return uris.map((u, i) => {
    if (typeof u !== 'string' || u.length === 0) {
      throw new AppError('DATA_VALIDATION', `redirect_uris[${i}] 格式無效`);
    }
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new AppError('DATA_VALIDATION', `redirect_uris[${i}] 不是合法 URL`);
    }
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !isLocalhost) {
      throw new AppError('DATA_VALIDATION', `redirect_uris[${i}] 必須是 HTTPS（localhost 例外）`);
    }
    // v2.33.58 round 12 H1: reject fragment / userinfo / query — exact-match downstream
    // 在 validate-authorize-request.ts 走 string equality，這些區段會被 parser confusion
    // / browser quirk 利用做 open-redirect 或 code leak via fragment。
    if (parsed.hash !== '') {
      throw new AppError('DATA_VALIDATION', `redirect_uris[${i}] 不可含 #fragment`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new AppError('DATA_VALIDATION', `redirect_uris[${i}] 不可含 userinfo (user:password@)`);
    }
    if (parsed.search !== '') {
      throw new AppError('DATA_VALIDATION', `redirect_uris[${i}] 不可含 ?query (OAuth 2.1 baseline)`);
    }
    return u;
  });
}
