/**
 * Invitation token helpers — V2 共編邀請 (跟 _session HMAC pattern 一致)
 *
 * Design：raw token 32 bytes base64url 隨機字串 → HMAC-SHA256(SESSION_SECRET, raw) →
 * 存 token_hash 進 trip_invitations.token_hash (PK)。raw token 只活在 email URL +
 * /invite query string。DB dump 不能直接反查 token，HMAC 才能比對。
 *
 * 為何不重用 _session.ts hmacSign：那個 module 用於 session token (long-lived 30d)，
 * semantic 不同。獨立 module 讓 invitation lifecycle 跟 session 解耦，未來換 algo
 * 不互相影響。
 */

// v2.33.59 round 13: HKDF domain separation
import { deriveSubSecret } from './hkdf';

const ALG = 'SHA-256';

/**
 * Inline copy of `generateOpaqueToken` (originally in functions/api/_utils.ts) —
 * 避免 src/ → functions/api/_utils 的 cross-boundary import 把 functions/api/_types.ts
 * (用 ambient `D1Database`) 拖進 frontend tsconfig graph 造成 tsc 找不到型別。
 * 5 行重複可接受，換得 src/ ↔ functions/ 邊界乾淨。
 */
function generateOpaqueToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: ALG },
    false,
    ['sign'],
  );
}

/**
 * Compute HMAC-SHA256(derived_secret, rawToken) → base64url for DB storage。
 *
 * v2.33.59 round 13: HMAC 改用 HKDF derived sub-secret (domain separation 跟
 * session.ts 隔離)。Invitations TTL 7 天 — 7 天後 backward compat 不需要，
 * 既有 token_hash 全 expire。直接 cutover, 無 dual-verify。
 */
export async function hashInvitationToken(rawToken: string, secret: string): Promise<string> {
  const subSecret = await deriveSubSecret(secret, 'invitation_token_v1');
  const key = await importHmacKey(subSecret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
  return base64urlEncodeBytes(new Uint8Array(sig));
}

/** Generate raw token + its HMAC hash in one call。raw 寄 email、hash 存 DB。 */
export async function generateInvitationToken(
  secret: string,
): Promise<{ rawToken: string; tokenHash: string }> {
  const rawToken = generateOpaqueToken();
  const tokenHash = await hashInvitationToken(rawToken, secret);
  return { rawToken, tokenHash };
}

/**
 * Default invitation TTL — referenced by permissions.ts, email template, InvitePage UI。
 * 改這個值 single source of truth，避免文案 / DB / UI 不同步。
 */
export const INVITATION_TTL_DAYS = 7;

/** ISO timestamp N days from now (default INVITATION_TTL_DAYS) */
export function invitationExpiresAt(daysFromNow = INVITATION_TTL_DAYS): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}
