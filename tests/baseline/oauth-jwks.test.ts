/**
 * /api/oauth/.well-known/jwks.json — V2-P5 JWKS endpoint（走 HTTP 邊界）
 */
import { describe, it, expect } from 'vitest';
import { createApi } from './http';
import type { Env } from '../../src/env';
import { keyMaterial } from '../signing-key-fixture';

const JWKS = 'https://x.com/api/oauth/.well-known/jwks.json';

function get(env: Partial<Env>) {
  return createApi({ env: env as Env }).get(JWKS);
}

async function generateTestPrivateKeyBase64(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(exported);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str);
}

describe('GET /api/oauth/.well-known/jwks.json', () => {
  it('200 with empty keys when env unset', async () => {
    const res = await get({});
    expect(res.status).toBe(200);
    const json = await res.json() as { keys: unknown[] };
    expect(json.keys).toEqual([]);
  });

  it('1h cache-control', async () => {
    const res = await get({});
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('publishes RFC 7517 JWK when OAUTH_SIGNING_PRIVATE_KEY set', async () => {
    const key = await generateTestPrivateKeyBase64();
    const res = await get({ OAUTH_SIGNING_PRIVATE_KEY: key });
    expect(res.status).toBe(200);
    const json = await res.json() as {
      keys: Array<{ kty: string; use: string; alg: string; kid: string; n: string; e: string }>;
    };
    expect(json.keys).toHaveLength(1);
    const jwk = json.keys[0]!;
    expect(jwk.kty).toBe('RSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.alg).toBe('RS256');
    expect(jwk.kid).toBeTruthy();
    expect(jwk.n.length).toBeGreaterThan(100);
    expect(jwk.e).toBe('AQAB'); // standard RSA exponent 65537
  });

  it('does NOT leak private key components (d, p, q)', async () => {
    const key = await generateTestPrivateKeyBase64();
    const res = await get({ OAUTH_SIGNING_PRIVATE_KEY: key });
    const json = await res.json() as { keys: Array<Record<string, unknown>> };
    const jwk = json.keys[0]!;
    expect(jwk.d).toBeUndefined();
    expect(jwk.p).toBeUndefined();
    expect(jwk.q).toBeUndefined();
    expect(jwk.dp).toBeUndefined();
    expect(jwk.dq).toBeUndefined();
    expect(jwk.qi).toBeUndefined();
  });

  it('returns empty keys (not 500) when env value is malformed', async () => {
    const res = await get({ OAUTH_SIGNING_PRIVATE_KEY: 'not-valid-base64!!!' });
    expect(res.status).toBe(200);
    const json = await res.json() as { keys: unknown[] };
    expect(json.keys).toEqual([]);
  });
});

describe('GET /api/oauth/.well-known/jwks.json — 金鑰貼錯的常見格式', () => {
  // production 曾因金鑰值格式不對，JWKS 靜默回空、id_token 靜默不簽發。可救的格式要能用，救不了的要明確判為無效。
  it.each([
    ['PKCS8 PEM（正確）→ 1 把', 'pem', 1],
    ['PKCS8 裸 base64 → 1 把', 'base64', 1],
    ['PKCS8 PEM，CRLF 換行 → 1 把', 'crlf', 1],
    ['PEM 換行被存成字面 \\n → 1 把', 'literalBackslashN', 1],
    ['PEM 外面包了引號 → 1 把', 'quoted', 1],
    ['PKCS1（BEGIN RSA PRIVATE KEY）：不支援 → 0 把', 'pkcs1Pem', 0],
    ['EC 金鑰：不支援（只簽 RS256）→ 0 把', 'ecPem', 0],
  ] as const)('%s', async (_name, field, expected) => {
    const mat = await keyMaterial();
    const res = await get({ OAUTH_SIGNING_PRIVATE_KEY: mat[field] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(expected);
  });

  it('只有空白／換行 → keys=0', async () => {
    const res = await get({ OAUTH_SIGNING_PRIVATE_KEY: '\n' });
    expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(0);
  });
});

