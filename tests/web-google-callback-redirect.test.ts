/**
 * tripline-web 登記 web 的 Google 登入回跳網址（母 spec：trip-planner.flutter#525、票 #526）。
 *
 * redirect_uri 一律精確比對（validateAuthorizeRequest），所以回跳網址要登記在 client_apps.redirect_uris；
 * 不做任何依 client_id 的豁免。走 HTTP 邊界（app.request）+ 真 SQLite（套用全部 migrations）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
const app = createApp();
beforeEach(() => { d1 = createD1(); });
afterEach(() => d1.close());

const WEB_CALLBACK = 'https://trip-planner-dby.pages.dev/auth/callback';
const PKCE = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };

function loginGoogle(clientId: string, redirect: string) {
  const env = {
    DB: d1.db, ALLOWED_ORIGINS: '', WEB_ORIGIN: 'https://trip-planner-dby.pages.dev',
    GOOGLE_CLIENT_ID: 'test-google-id', GOOGLE_CLIENT_SECRET: 'test-google-secret',
    ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.example.test',
  } as Env;
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state: 's1', ...PKCE });
  return app.request(`https://api.example.test/api/oauth/login/google?${q}`, {}, env);
}

const uris = (clientId: string) =>
  (d1.raw.prepare('SELECT redirect_uris FROM client_apps WHERE client_id = ?').get(clientId) as { redirect_uris: string }).redirect_uris;
const setUris = (clientId: string, v: string) => d1.raw.prepare('UPDATE client_apps SET redirect_uris = ? WHERE client_id = ?').run(v, clientId);

describe('tripline-web 的 Google 登入回跳網址', () => {
  it('以登記的回跳網址發起 → 302 到 accounts.google.com', async () => {
    const res = await loginGoogle('tripline-web', WEB_CALLBACK);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).origin).toBe('https://accounts.google.com');
  });

  it('別的回跳網址仍被拒（精確比對：不同路徑、前綴、不同網域）', async () => {
    for (const bad of [
      'https://trip-planner-dby.pages.dev/auth/callback/extra',
      'https://trip-planner-dby.pages.dev/auth/callback?x=1',
      'https://trip-planner-dby.pages.dev/other',
      'https://evil.example.test/auth/callback',
    ]) {
      const res = await loginGoogle('tripline-web', bad);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get('location'), bad).toBeNull();
    }
  });

  it('只登記給 tripline-web：其他 client 用同一個回跳網址仍被拒，且它們的 redirect_uris 沒被動到', async () => {
    const others = (d1.raw.prepare("SELECT client_id FROM client_apps WHERE client_id != 'tripline-web'").all() as { client_id: string }[]).map((r) => r.client_id);
    expect(others).toContain('tripline-mobile');
    for (const id of others) {
      expect(JSON.parse(uris(id)), id).not.toContain(WEB_CALLBACK);
      const res = await loginGoogle(id, WEB_CALLBACK);
      expect(res.status, id).toBe(400);
    }
  });

  it('冪等：重跑 migration 後 redirect_uris 不變、不重複', () => {
    const before = uris('tripline-web');
    expect(JSON.parse(before)).toEqual([WEB_CALLBACK]);
    d1.applyMigrationsAfter(101);
    expect(uris('tripline-web')).toBe(before);
  });

  it('保留既有登記：原本已有其他網址時附加，不覆蓋，重跑也不重複', () => {
    setUris('tripline-web', JSON.stringify(['https://other.example.test/cb']));
    d1.applyMigrationsAfter(101);
    expect(JSON.parse(uris('tripline-web'))).toEqual(['https://other.example.test/cb', WEB_CALLBACK]);
    d1.applyMigrationsAfter(101);
    expect(JSON.parse(uris('tripline-web'))).toEqual(['https://other.example.test/cb', WEB_CALLBACK]);
  });

  it('其他欄位不動（allowed_scopes、first_party）', () => {
    const before = d1.raw.prepare("SELECT allowed_scopes, first_party, status FROM client_apps WHERE client_id = 'tripline-web'").get();
    setUris('tripline-web', '[]');
    d1.applyMigrationsAfter(101);
    expect(d1.raw.prepare("SELECT allowed_scopes, first_party, status FROM client_apps WHERE client_id = 'tripline-web'").get()).toEqual(before);
  });
});
