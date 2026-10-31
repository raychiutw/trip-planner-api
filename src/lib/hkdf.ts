/**
 * hkdf.ts — RFC 5869 HKDF-SHA256 sub-secret derivation
 *
 * v2.33.59 round 13: HMAC domain separation。之前 session.ts 跟 invitation-token.ts
 * 共用 SESSION_SECRET 直接 HMAC，雖然不同 message 輸入結構不會 collision，但 cryptographic
 * hygiene best practice 是各 protocol 用 derived sub-key — 未來新增 HMAC 用途也安全。
 *
 * Web Crypto 原生支援 HKDF (deriveBits)。in-isolate cache 避免重複 importKey。
 */
import { toArrayBuffer } from './cryptoBuffer';

const INFO_PREFIX = 'tripline.';
type SubKeyName = 'session_v1' | 'invitation_token_v1';

const cache = new Map<string, string>();

function bytesToBase64url(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive a 32-byte sub-secret from masterSecret using HKDF-SHA256 with `info` as
 * domain-separating context tag. Result is base64url string (43 chars, no padding).
 *
 * Deterministic — same (masterSecret, info) → same output. Cached in-isolate.
 */
export async function deriveSubSecret(masterSecret: string, info: SubKeyName): Promise<string> {
  const cacheKey = `${masterSecret}:${info}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const masterKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(masterSecret)),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(new Uint8Array(0)),
      info: toArrayBuffer(new TextEncoder().encode(INFO_PREFIX + info)),
    },
    masterKey,
    256,
  );
  const sub = bytesToBase64url(new Uint8Array(derivedBits));
  cache.set(cacheKey, sub);
  return sub;
}

/** Reset in-isolate cache — for tests only. */
export function _resetHkdfCacheForTest(): void {
  cache.clear();
}
