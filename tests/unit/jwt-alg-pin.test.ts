// @ts-nocheck — 逐字搬自舊 repo（其 tsconfig 較寬鬆）；型別嚴格度差異不影響執行語意。
/**
 * jwt-alg-pin.test.ts — v2.33.58 round 12 C1 algorithm-confusion defense
 *
 * verifyJwt 必須在 signature check 前 assert header.alg 在 allowlist 內，
 * 拒 alg=none / HS256 / 任何非 RS256 algorithm。
 */
import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, importPrivateKey } from '../../src/lib/jwt';

async function generateRsaKeypair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
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

function base64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('verifyJwt — alg pin (v2.33.58 C1)', () => {
  it('happy: 接受 RS256 simgned token', async () => {
    const { privateKey, publicKey } = await generateRsaKeypair();
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: Math.floor(Date.now() / 1000) + 60 },
      privateKey,
      'kid-1',
    );
    const claims = await verifyJwt(token, publicKey);
    expect(claims.iss).toBe('i');
  });

  it('拒 alg=none (即使 signature 為空)', async () => {
    const { publicKey } = await generateRsaKeypair();
    const header = base64url('{"alg":"none","typ":"JWT","kid":"k"}');
    const payload = base64url(JSON.stringify({ iss: 'i', aud: 'a', exp: Math.floor(Date.now() / 1000) + 60 }));
    const token = `${header}.${payload}.`;
    await expect(verifyJwt(token, publicKey)).rejects.toThrow(/alg not permitted/);
  });

  it('拒 alg=HS256 (algorithm confusion - 公鑰當 HMAC secret 攻擊)', async () => {
    const { publicKey } = await generateRsaKeypair();
    const header = base64url('{"alg":"HS256","typ":"JWT","kid":"k"}');
    const payload = base64url(JSON.stringify({ iss: 'i', aud: 'a', exp: Math.floor(Date.now() / 1000) + 60 }));
    const token = `${header}.${payload}.fake-hmac-sig`;
    await expect(verifyJwt(token, publicKey)).rejects.toThrow(/alg not permitted/);
  });

  it('拒 alg=ES256', async () => {
    const { publicKey } = await generateRsaKeypair();
    const header = base64url('{"alg":"ES256","typ":"JWT"}');
    const payload = base64url(JSON.stringify({ iss: 'i', aud: 'a', exp: Math.floor(Date.now() / 1000) + 60 }));
    const token = `${header}.${payload}.fake-sig`;
    await expect(verifyJwt(token, publicKey)).rejects.toThrow(/alg not permitted/);
  });

  it('拒 typ != JWT', async () => {
    const { privateKey, publicKey } = await generateRsaKeypair();
    // Sign 正常 token，然後手動換 header typ
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: Math.floor(Date.now() / 1000) + 60 },
      privateKey,
      'kid-1',
    );
    const parts = token.split('.');
    const fakeHeader = base64url('{"alg":"RS256","typ":"BAD","kid":"kid-1"}');
    const fakeToken = `${fakeHeader}.${parts[1]}.${parts[2]}`;
    await expect(verifyJwt(fakeToken, publicKey)).rejects.toThrow(/typ invalid/);
  });

  it('expectedAlg 可 override (e.g. allow ES256 if explicitly opted in)', async () => {
    const { privateKey, publicKey } = await generateRsaKeypair();
    const token = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: Math.floor(Date.now() / 1000) + 60 },
      privateKey,
      'kid-1',
    );
    // Pass option allowing RS256 explicitly — still works
    const claims = await verifyJwt(token, publicKey, { expectedAlg: ['RS256'] });
    expect(claims.iss).toBe('i');
  });
});

describe('verifyJwt — exp 嚴格 (v2.33.58 I2)', () => {
  it('過期 5 秒就拒 (拔掉 60s 寬限)', async () => {
    const { privateKey, publicKey } = await generateRsaKeypair();
    const expiredToken = await signJwt(
      { iss: 'i', sub: 's', aud: 'a', exp: Math.floor(Date.now() / 1000) - 5 },
      privateKey,
      'kid-1',
    );
    await expect(verifyJwt(expiredToken, publicKey)).rejects.toThrow(/expired/);
  });

  it('nbf clockSkew 仍保留 (issuer clock ahead tolerance)', async () => {
    const { privateKey, publicKey } = await generateRsaKeypair();
    const nbfTokenSlightlyAhead = await signJwt(
      {
        iss: 'i',
        sub: 's',
        aud: 'a',
        exp: Math.floor(Date.now() / 1000) + 300,
        nbf: Math.floor(Date.now() / 1000) + 30, // 30s ahead, within default 60s skew
      },
      privateKey,
      'kid-1',
    );
    const claims = await verifyJwt(nbfTokenSlightlyAhead, publicKey);
    expect(claims.iss).toBe('i');
  });
});
// Suppress unused import lint
void importPrivateKey;
