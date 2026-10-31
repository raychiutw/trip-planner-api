/** 測試用 DPoP client：產 ES256 金鑰、簽 proof JWT、算 RFC 7638 thumbprint（獨立於 src 實作）。 */
import { createHash } from 'node:crypto';

export interface DpopKey { privateKey: CryptoKey; jwk: { kty: string; crv: string; x: string; y: string }; jkt: string }

const b64u = (b: ArrayBuffer | Uint8Array | Buffer | string) => Buffer.from(typeof b === 'string' ? Buffer.from(b) : (b as Uint8Array)).toString('base64url');

export async function newKey(): Promise<DpopKey> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const full = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const jwk = { kty: full.kty!, crv: full.crv!, x: full.x!, y: full.y! };
  // RFC 7638：必要成員依字典序、無空白
  const jkt = createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).digest('base64url');
  return { privateKey: kp.privateKey, jwk, jkt };
}

export interface ProofOpts {
  htm?: string; htu?: string; iat?: number; jti?: string | null; ath?: string;
  typ?: string; alg?: string; jwk?: Record<string, unknown>; omit?: string[]; signWith?: CryptoKey;
}

export async function proof(key: DpopKey, o: ProofOpts = {}): Promise<string> {
  const header = { typ: o.typ ?? 'dpop+jwt', alg: o.alg ?? 'ES256', jwk: o.jwk ?? key.jwk };
  const claims: Record<string, unknown> = {
    jti: o.jti === null ? undefined : (o.jti ?? crypto.randomUUID()),
    htm: o.htm ?? 'POST',
    htu: o.htu ?? 'http://localhost/api/oauth/token',
    iat: o.iat ?? Math.floor(Date.now() / 1000),
  };
  if (o.ath !== undefined) claims.ath = o.ath;
  for (const k of o.omit ?? []) delete claims[k];
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = o.alg === 'none' ? '' : b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.signWith ?? key.privateKey, Buffer.from(input)));
  return `${input}.${sig}`;
}

export const athOf = (token: string) => createHash('sha256').update(token).digest('base64url');
