// @ts-nocheck — 逐字搬自舊 repo（其 tsconfig 較寬鬆）；型別嚴格度差異不影響執行語意。
/**
 * src/server/jwt.ts unit test — V2-P5 RS256 id_token signing
 */
import { describe, it, expect } from 'vitest';
import {
  signJwt,
  verifyJwt,
  importPrivateKey,
  exportPublicJwk,
  computeKid,
  derivePublicKey,
} from '../../src/lib/jwt';

async function generateTestKeypair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

describe('signJwt + verifyJwt', () => {
  it('round-trip: sign then verify same claims', async () => {
    const { privateKey, publicKey } = await generateTestKeypair();
    const claims = {
      iss: 'https://x.com',
      sub: 'user-1',
      aud: 'app-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      email: 'u@example.com',
    };
    const token = await signJwt(claims, privateKey, 'test-kid');
    expect(token.split('.').length).toBe(3); // header.payload.sig
    const verified = await verifyJwt(token, publicKey);
    expect(verified.iss).toBe('https://x.com');
    expect(verified.sub).toBe('user-1');
    expect(verified.email).toBe('u@example.com');
  });

  it('header includes kid + alg=RS256 + typ=JWT', async () => {
    const { privateKey } = await generateTestKeypair();
    const claims = {
      iss: 'i', sub: 's', aud: 'a',
      exp: 0, iat: 0,
    };
    const token = await signJwt(claims, privateKey, 'kid-abc');
    const headerBase64 = token.split('.')[0]!;
    const padded = headerBase64.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const header = JSON.parse(atob(padded + '='.repeat(padLen))) as Record<string, string>;
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe('kid-abc');
  });

  it('verifyJwt throws on tampered signature', async () => {
    const { privateKey, publicKey } = await generateTestKeypair();
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: 0, iat: 0 },
      privateKey,
      'k',
    );
    // Flip a character in the signature
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}aa`;
    await expect(verifyJwt(tampered, publicKey)).rejects.toThrow();
  });

  it('verifyJwt throws on wrong public key', async () => {
    const a = await generateTestKeypair();
    const b = await generateTestKeypair();
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: 0, iat: 0 },
      a.privateKey,
      'k',
    );
    await expect(verifyJwt(token, b.publicKey)).rejects.toThrow();
  });

  it('verifyJwt throws when token has wrong shape', async () => {
    const { publicKey } = await generateTestKeypair();
    await expect(verifyJwt('not.a.jwt.token', publicKey)).rejects.toThrow();
    await expect(verifyJwt('only-one-part', publicKey)).rejects.toThrow();
  });
});

describe('verifyJwt claim validation', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  async function signedToken(claimsOverride: Record<string, unknown>) {
    const { privateKey, publicKey } = await generateTestKeypair();
    const claims = {
      iss: 'https://issuer.example',
      sub: 'user-1',
      aud: 'client-1',
      exp: nowSec + 3600,
      iat: nowSec,
      ...claimsOverride,
    };
    const token = await signJwt(claims as never, privateKey, 'k');
    return { token, publicKey };
  }

  it('throws when exp is in the past (token expired)', async () => {
    const { token, publicKey } = await signedToken({ exp: nowSec - 120 });
    await expect(verifyJwt(token, publicKey)).rejects.toThrow(/expired/i);
  });

  it('throws JWT expired when exp < now（v2.33.58 round 12 I2: skew 只 apply nbf 不放寬 exp）', async () => {
    // exp 30s in the past — round 12 I2 stricter: no skew tolerance on exp
    const { token, publicKey } = await signedToken({ exp: nowSec - 30 });
    await expect(verifyJwt(token, publicKey)).rejects.toThrow(/expired/i);
  });

  it('throws when nbf is in the future (token not yet valid)', async () => {
    const { token, publicKey } = await signedToken({ nbf: nowSec + 600 });
    await expect(verifyJwt(token, publicKey)).rejects.toThrow(/nbf/i);
  });

  it('throws on iss mismatch when expectedIss provided', async () => {
    const { token, publicKey } = await signedToken({ iss: 'https://attacker.com' });
    await expect(
      verifyJwt(token, publicKey, { expectedIss: 'https://issuer.example' }),
    ).rejects.toThrow(/iss/i);
  });

  it('accepts iss when expectedIss is an array containing it', async () => {
    const { token, publicKey } = await signedToken({ iss: 'accounts.google.com' });
    await expect(
      verifyJwt(token, publicKey, {
        expectedIss: ['https://accounts.google.com', 'accounts.google.com'],
      }),
    ).resolves.toBeDefined();
  });

  it('throws on aud mismatch when expectedAud provided', async () => {
    const { token, publicKey } = await signedToken({ aud: 'different-client' });
    await expect(
      verifyJwt(token, publicKey, { expectedAud: 'client-1' }),
    ).rejects.toThrow(/aud/i);
  });

  it('accepts when aud is array and contains expectedAud', async () => {
    const { token, publicKey } = await signedToken({ aud: ['other', 'client-1'] });
    await expect(
      verifyJwt(token, publicKey, { expectedAud: 'client-1' }),
    ).resolves.toBeDefined();
  });

  it('clockSkewSec=0 fails token issued exactly now (no slack)', async () => {
    const { token, publicKey } = await signedToken({ exp: nowSec });
    await expect(
      verifyJwt(token, publicKey, { clockSkewSec: 0, now: nowSec }),
    ).rejects.toThrow(/expired/i);
  });
});

describe('exportPublicJwk', () => {
  it('returns RFC 7517 JWK with kty=RSA, use=sig, alg=RS256, kid', async () => {
    const { privateKey } = await generateTestKeypair();
    const jwk = await exportPublicJwk(privateKey, 'test-kid-123');
    expect(jwk.kty).toBe('RSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.alg).toBe('RS256');
    expect(jwk.kid).toBe('test-kid-123');
    expect(typeof jwk.n).toBe('string');
    expect(typeof jwk.e).toBe('string');
    expect(jwk.n.length).toBeGreaterThan(100); // 2048-bit modulus base64-encoded ~342 chars
  });

  it('does NOT leak private key components (d, p, q, dp, dq, qi)', async () => {
    const { privateKey } = await generateTestKeypair();
    const jwk = await exportPublicJwk(privateKey, 'k');
    expect((jwk as Record<string, unknown>).d).toBeUndefined();
    expect((jwk as Record<string, unknown>).p).toBeUndefined();
    expect((jwk as Record<string, unknown>).q).toBeUndefined();
  });
});

describe('computeKid', () => {
  it('deterministic: same key → same kid', async () => {
    const { privateKey } = await generateTestKeypair();
    const k1 = await computeKid(privateKey);
    const k2 = await computeKid(privateKey);
    expect(k1).toBe(k2);
  });

  it('different keys → different kids', async () => {
    const a = await generateTestKeypair();
    const b = await generateTestKeypair();
    expect(await computeKid(a.privateKey)).not.toBe(await computeKid(b.privateKey));
  });
});

describe('importPrivateKey', () => {
  it('imports raw PKCS8 base64 (no PEM headers)', async () => {
    const { privateKey } = await generateTestKeypair();
    const exported = await crypto.subtle.exportKey('pkcs8', privateKey);
    const bytes = new Uint8Array(exported);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
    const base64 = btoa(str);

    const reimported = await importPrivateKey(base64);
    // Sanity: should be able to sign with it
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: 0, iat: 0 },
      reimported,
      'k',
    );
    expect(token.split('.').length).toBe(3);
  });

  it('imports PEM-wrapped PKCS8', async () => {
    const { privateKey } = await generateTestKeypair();
    const exported = await crypto.subtle.exportKey('pkcs8', privateKey);
    const bytes = new Uint8Array(exported);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
    const base64 = btoa(str);
    const pem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? base64}\n-----END PRIVATE KEY-----`;

    const reimported = await importPrivateKey(pem);
    const publicKey = await derivePublicKey(reimported);
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: futureExp, iat: Math.floor(Date.now() / 1000) },
      reimported,
      'k',
    );
    const claims = await verifyJwt(token, publicKey);
    expect(claims.sub).toBe('s');
  });
});
