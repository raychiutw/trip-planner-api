/**
 * Session token module — V2-P1 (per docs/v2-oauth-server-plan.md V2-P6 spec)
 *
 * Opaque session cookie + SHA-256 HMAC（非 JWT — 避免 JWT 慣性 sec issues：
 * alg=none, key confusion, expiry-bypass-via-payload-edit 等）。Token 結構：
 *
 *   <base64url payload>.<base64url hmac>
 *
 * Payload JSON 含：
 *   - uid: user.id
 *   - iat: issued at (unix sec)
 *   - exp: expires at (unix sec)
 *   - csrf: 32-byte random nonce — **未實際做 double-submit token 驗證**。
 *     v2.33.58 round 12 H5: 之前 comment 誇大「POST/PUT/DELETE 都驗」實際無
 *     endpoint 讀 payload.csrf 跟 request header / form field 比對。CSRF
 *     defense 目前**僅靠** `_middleware.ts` Origin allowlist + Cookie
 *     `SameSite=Lax`。`csrf` field 保留為 future-proof（如要加 double-submit
 *     檢查可基於此 field），但勿假設此防護已啟用。
 *
 * 驗證：HMAC(secret, payload) === provided_hmac → 接受；過期 reject。
 *
 * 為何用 Web Crypto 而非 JWT lib：
 *   - CF Workers Web Crypto 是 native，不需 nodejs_compat
 *   - 控制權：自定 payload schema 不必 jose / jsonwebtoken 依賴
 *   - Spec align：V2-P6 explicit「opaque session cookie + SHA-256 hash（非 JWT）」
 *
 * 不負責（其他 module）：
 *   - User authentication（OAuth flow / password verify → 才 issue session）
 *   - Cookie storage（這個 module 只管 sign/verify token string；
 *     setSessionCookie / getSessionCookie helper 在 functions/api/_cookies.ts）
 */

const SESSION_VERSION = 1;
const ALG = 'SHA-256';

export interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
  csrf: string;
  /** Schema version 預留 — V2-P1 = 1 */
  v: number;
  /** V2-P6 session id — for multi-device tracking + remote revocation。Legacy
   * session（V2-P1）沒有此欄；revocation check 時遇 undefined 視為「無法 revoke」。
   */
  sid?: string;
  [key: string]: unknown;
}

/** base64url (no padding, URL-safe) — sign 用，跟 JWT 同 encoding */
function base64urlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let str = '';
  // noUncheckedIndexedAccess: buf[i] 是 number | undefined；range 安全用 ! assertion
  for (let i = 0; i < buf.length; i++) str += String.fromCharCode(buf[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// v2.33.59 round 13: HKDF domain separation
import { deriveSubSecret } from './hkdf';

// v2.33.63 round 14d: in-isolate CryptoKey cache — 之前 verifySessionToken 每
// request 都 importKey(~1ms)，每 authenticated route 都 fire 一次。Cache 1 key/secret
// keep CryptoKey alive 整 isolate lifetime。secret 不 rotate 期間穩定。
const KEY_CACHE = new Map<string, CryptoKey>();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const hit = KEY_CACHE.get(secret);
  if (hit) return hit;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: ALG },
    false,
    ['sign', 'verify'],
  );
  KEY_CACHE.set(secret, key);
  return key;
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

/** Constant-time compare — 避免 timing attack 推 HMAC byte-by-byte */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Generate cryptographically random CSRF token (32 bytes → 43 char base64url) */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/**
 * Sign session token — return `<payload>.<hmac>` string。
 *
 * @param uid user.id
 * @param secret session signing secret (env)
 * @param ttlSeconds default 30 days (long-lived web session)
 */
export async function signSessionToken(
  uid: string,
  secret: string,
  ttlSeconds = 30 * 24 * 60 * 60,
  sid?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    uid,
    iat: now,
    exp: now + ttlSeconds,
    csrf: generateCsrfToken(),
    ...(sid ? { sid } : {}),
  };
  const payloadStr = base64urlEncode(JSON.stringify(payload));
  // v2.33.59 round 13: HMAC sign 改用 HKDF derived sub-secret (domain separation)
  const sessionKey = await deriveSubSecret(secret, 'session_v1');
  const sig = await hmacSign(sessionKey, payloadStr);
  return `${payloadStr}.${sig}`;
}

/**
 * Verify session token — return parsed payload if valid, null otherwise。
 *
 * Reject conditions:
 *   - format invalid (not exactly 1 dot)
 *   - HMAC mismatch (tampered or wrong secret)
 *   - exp < now (expired)
 *   - v not supported (future schema migration)
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, providedSig] = parts;
  // noUncheckedIndexedAccess 推為 string | undefined — runtime 已 length===2 但 TS 不知
  if (!payloadStr || !providedSig) return null;

  // v2.33.59 round 13: 雙路徑 verify — 先試 derived (新 sign 用)，再 fallback 試 raw
  // (舊 sessions backward compat, 30-day TTL 後 fallback 可拔)。Both branches return
  // null on mismatch — constant-time within each attempt; total time leak < 1 path
  // difference, acceptable for 30d migration window。
  const sessionKey = await deriveSubSecret(secret, 'session_v1');
  const derivedSig = await hmacSign(sessionKey, payloadStr);
  let signatureOk = constantTimeEquals(derivedSig, providedSig);
  if (!signatureOk) {
    const legacySig = await hmacSign(secret, payloadStr);
    signatureOk = constantTimeEquals(legacySig, providedSig);
  }
  if (!signatureOk) return null;

  let payload: SessionPayload;
  try {
    const json = new TextDecoder().decode(base64urlDecode(payloadStr));
    payload = JSON.parse(json) as SessionPayload;
  } catch {
    return null;
  }

  if (payload.v !== SESSION_VERSION) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.uid !== 'string' || !payload.uid) return null;

  return payload;
}
