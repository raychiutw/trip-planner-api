/**
 * mobileCallbackUrl：mobile callback 的設定驗證（自舊入口 tests/unit/mobile-callback-url.test.ts 移植）。
 * production／preview 一律要 https；只有 development 允許 http loopback，
 * 而且 development 沒設定時以 contract 的 dev 值為預設，本機才跑得了 mobile 的刪除流程。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mobileCallbackUrl } from '../../src/lib/delete-reauth';
import { MOBILE_DEV_REDIRECT, MOBILE_PROD_REDIRECT, MOBILE_UAT_REDIRECT, mobileOAuthContract } from '../../src/lib/mobile-oauth';
import type { Env } from '../../src/env';

const code = (fn: () => unknown) => {
  try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'ERR'; }
};

describe('mobileCallbackUrl', () => {
  it('production：https 且設定了才通過', () => {
    expect(mobileCallbackUrl({ ENVIRONMENT: 'production', MOBILE_OAUTH_CALLBACK_URL: MOBILE_PROD_REDIRECT }).toString()).toBe(MOBILE_PROD_REDIRECT);
  });

  it('production 沒設定 → SERVER_MISCONFIG（不套用 dev 預設）', () => {
    expect(code(() => mobileCallbackUrl({ ENVIRONMENT: 'production' }))).toBe('SERVER_MISCONFIG');
  });

  it('production／preview／未設環境的 http（含 loopback）一律拒絕', () => {
    for (const env of ['production', 'preview', undefined] as const) {
      expect(code(() => mobileCallbackUrl({ ENVIRONMENT: env, MOBILE_OAUTH_CALLBACK_URL: 'http://127.0.0.1:8765' })), String(env)).toBe('SERVER_MISCONFIG');
    }
  });

  it('development 沒設定 → 以 contract 的 dev redirect 為預設（http loopback）', () => {
    expect(mobileCallbackUrl({ ENVIRONMENT: 'development' }).toString()).toBe(new URL(MOBILE_DEV_REDIRECT).toString());
  });

  it('development 明確設定 http loopback → 通過；localhost 也算 loopback', () => {
    expect(mobileCallbackUrl({ ENVIRONMENT: 'development', MOBILE_OAUTH_CALLBACK_URL: 'http://localhost:9000' }).hostname).toBe('localhost');
  });

  it('development 的 http 但不是 loopback（例如公網主機）→ 拒絕', () => {
    expect(code(() => mobileCallbackUrl({ ENVIRONMENT: 'development', MOBILE_OAUTH_CALLBACK_URL: 'http://evil.example' }))).toBe('SERVER_MISCONFIG');
  });

  it('任何環境都拒絕帶 query、hash、帳密的 URL', () => {
    for (const bad of ['https://x.example/cb?a=1', 'https://x.example/cb#f', 'https://u:p@x.example/cb']) {
      expect(code(() => mobileCallbackUrl({ ENVIRONMENT: 'production', MOBILE_OAUTH_CALLBACK_URL: bad })), bad).toBe('SERVER_MISCONFIG');
    }
  });
});

describe('mobileOAuthContract：精確的 issuer／client／redirect 組合', () => {
  const at = (origin: string) => new Request(`${origin}/api/account/delete-reauth`);
  const env = (over: Partial<Env>) => over as Env;

  it('production：請求 origin 必須是 PUBLIC_ORIGIN', () => {
    const e = env({ ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.example' });
    expect(mobileOAuthContract(e, at('https://api.example'))).toEqual({ clientId: 'tripline-mobile', redirectUri: MOBILE_PROD_REDIRECT });
    expect(mobileOAuthContract(e, at('https://evil.example'))).toBeNull();
  });

  it('preview：只有 origin 等於明確設定的 PUBLIC_ORIGIN 才通過；沒設 PUBLIC_ORIGIN 一律不通過', () => {
    expect(mobileOAuthContract(env({ ENVIRONMENT: 'preview', PUBLIC_ORIGIN: 'https://stg.example/' }), at('https://stg.example'))).toEqual({ clientId: 'tripline-mobile-uat', redirectUri: MOBILE_UAT_REDIRECT });
    expect(mobileOAuthContract(env({ ENVIRONMENT: 'preview', PUBLIC_ORIGIN: 'https://stg.example' }), at('https://random.example'))).toBeNull();
    expect(mobileOAuthContract(env({ ENVIRONMENT: 'preview' }), at('https://stg.example'))).toBeNull();
  });

  it('development：只認 localhost／127.0.0.1；沒有環境或其他值 → null（不跨環境 fallback）', () => {
    expect(mobileOAuthContract(env({ ENVIRONMENT: 'development' }), at('http://localhost:8788'))).toEqual({ clientId: 'tripline-mobile-dev', redirectUri: MOBILE_DEV_REDIRECT });
    expect(mobileOAuthContract(env({ ENVIRONMENT: 'development' }), at('http://evil.example'))).toBeNull();
    expect(mobileOAuthContract(env({}), at('http://localhost:8788'))).toBeNull();
  });
});

describe('wrangler.toml 的 callback 設定與環境契約一致', () => {
  const toml = readFileSync(path.join(__dirname, '../../wrangler.toml'), 'utf8');
  const [top, prod] = toml.split('[env.production]');
  const val = (src: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(src)?.[1];

  it('staging（頂層 [vars]）：preview 環境、明確的 PUBLIC_ORIGIN、UAT callback，且通過 mobileCallbackUrl 驗證', () => {
    expect(val(top!, 'ENVIRONMENT')).toBe('preview');
    expect(val(top!, 'PUBLIC_ORIGIN')).toMatch(/^https:\/\//);
    expect(val(top!, 'MOBILE_OAUTH_CALLBACK_URL')).toBe(MOBILE_UAT_REDIRECT);
    expect(mobileCallbackUrl({ ENVIRONMENT: 'preview', MOBILE_OAUTH_CALLBACK_URL: val(top!, 'MOBILE_OAUTH_CALLBACK_URL') }).toString()).toBe(MOBILE_UAT_REDIRECT);
  });

  it('production：callback 是 production 的 app link，且 staging 與 production 不共用', () => {
    expect(val(prod!, 'ENVIRONMENT')).toBe('production');
    expect(val(prod!, 'MOBILE_OAUTH_CALLBACK_URL')).toBe(MOBILE_PROD_REDIRECT);
    expect(val(prod!, 'PUBLIC_ORIGIN')).not.toBe(val(top!, 'PUBLIC_ORIGIN'));
  });
});
