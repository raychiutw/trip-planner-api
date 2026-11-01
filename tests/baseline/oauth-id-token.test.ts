/**
 * issueIdToken（oauth/_id_token）—— token endpoint 之後會接；這裡先驗它自己。
 * 缺簽章 key 時略過簽發（回 null），不是失敗；issuer 由 getOidcIssuer（PUBLIC_ORIGIN）決定。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { issueIdToken } from '../../src/routes/handlers/oauth/_id_token';
import { verifyJwt, importPrivateKey, derivePublicKey, computeKid, decodeJwtHeader } from '../../src/lib/jwt';
import type { Env } from '../../src/env';

const USER = 'h1-idt-user';
let db: D1Database;
let keyB64: string;

beforeAll(async () => {
  db = await createTestDb();
  await db.prepare('INSERT OR REPLACE INTO users (id, email, display_name, email_verified_at) VALUES (?, ?, ?, ?)')
    .bind(USER, 'h1-idt@example.com', 'Idt Name', '2026-01-01T00:00:00.000Z').run();
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  )) as CryptoKeyPair;
  const bytes = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  keyB64 = btoa(str);
});
afterAll(async () => {
  await db.prepare('DELETE FROM users WHERE id = ?').bind(USER).run();
  await disposeMiniflare();
});

const req = new Request('https://x.com/api/oauth/token', { method: 'POST' });
const env = (over: Partial<Env> = {}) => mockEnv(db, over);

describe('issueIdToken', () => {
  it('scope 不含 openid → null', async () => {
    expect(await issueIdToken(env({ OAUTH_SIGNING_PRIVATE_KEY: keyB64 }), req, 'c', USER, ['profile'])).toBeNull();
  });

  it('缺 OAUTH_SIGNING_PRIVATE_KEY → 略過簽發（null），不丟錯', async () => {
    await expect(issueIdToken(env(), req, 'c', USER, ['openid'])).resolves.toBeNull();
  });

  it('使用者不存在 → 丟錯（不簽給不存在的人）', async () => {
    await expect(issueIdToken(env({ OAUTH_SIGNING_PRIVATE_KEY: keyB64 }), req, 'c', 'h1-idt-ghost', ['openid'])).rejects.toThrow();
  });

  it('簽出可驗證的 JWT：iss = PUBLIC_ORIGIN/api/oauth、aud = client、sub = user；email／profile 依 scope', async () => {
    const e = env({ OAUTH_SIGNING_PRIVATE_KEY: keyB64, PUBLIC_ORIGIN: 'https://issuer.example' });
    const token = (await issueIdToken(e, req, 'client-1', USER, ['openid', 'profile', 'email']))!;
    const priv = await importPrivateKey(keyB64);
    expect(decodeJwtHeader(token).kid).toBe(await computeKid(priv));
    const claims = await verifyJwt(token, await derivePublicKey(priv), { expectedIss: 'https://issuer.example/api/oauth', expectedAud: 'client-1' });
    expect(claims).toMatchObject({ sub: USER, email: 'h1-idt@example.com', email_verified: true, name: 'Idt Name' });
    expect(claims.exp! - claims.iat!).toBe(3600);
  });

  it('只有 openid：不帶 email／name', async () => {
    const e = env({ OAUTH_SIGNING_PRIVATE_KEY: keyB64, PUBLIC_ORIGIN: 'https://issuer.example' });
    const token = (await issueIdToken(e, req, 'client-1', USER, ['openid']))!;
    const claims = await verifyJwt(token, await derivePublicKey(await importPrivateKey(keyB64)), { expectedIss: 'https://issuer.example/api/oauth', expectedAud: 'client-1' });
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
  });
});
