/**
 * /api/oauth/.well-known/openid-configuration —— issuer 一律由 getOidcIssuer（PUBLIC_ORIGIN）決定，
 * 不信任 request 的 Host。
 */
import { describe, it, expect } from 'vitest';
import { createApi } from './http';
import type { Env } from '../../src/env';

const get = (env: Partial<Env>, url = 'https://evil-host.example/api/oauth/.well-known/openid-configuration') =>
  createApi({ env: env as Env }).get(url);

describe('GET /api/oauth/.well-known/openid-configuration', () => {
  it('issuer 與各 endpoint 以 PUBLIC_ORIGIN 為準（不是 request Host）', async () => {
    const res = await get({ PUBLIC_ORIGIN: 'https://issuer.example/' });
    expect(res.status).toBe(200);
    const doc = await res.json() as Record<string, unknown>;
    expect(doc.issuer).toBe('https://issuer.example/api/oauth');
    expect(doc.authorization_endpoint).toBe('https://issuer.example/api/oauth/authorize');
    expect(doc.token_endpoint).toBe('https://issuer.example/api/oauth/token');
    expect(doc.userinfo_endpoint).toBe('https://issuer.example/api/oauth/userinfo');
    expect(doc.jwks_uri).toBe('https://issuer.example/api/oauth/.well-known/jwks.json');
    expect(doc.revocation_endpoint).toBe('https://issuer.example/api/oauth/revoke');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('production 沒設 PUBLIC_ORIGIN → 退回標準 origin，絕不用 request Host', async () => {
    const doc = await (await get({ ENVIRONMENT: 'production' })).json() as { issuer: string };
    expect(doc.issuer).toBe('https://trip-planner-dby.pages.dev/api/oauth');
  });
});
