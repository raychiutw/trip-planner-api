/**
 * 第一方 mobile／web client 的行程 scope 登記（母 spec：trip-planner.flutter#517、票 #519）。
 *
 * 走標準 OAuth：授權伺服器在 client_apps.allowed_scopes 登記 trips:read／trips:write，
 * 授權請求才能要到；資源伺服器只檢查 token 上的 scope。
 * 走 HTTP 邊界（app.request）+ 真 SQLite（套用全部 migrations）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createD1 } from './support/d1';
import { MOBILE_PROD_REDIRECT, MOBILE_UAT_REDIRECT, MOBILE_DEV_REDIRECT } from '../src/lib/mobile-oauth';

let d1: ReturnType<typeof createD1>;
const app = createApp();
beforeEach(() => { d1 = createD1(); });
afterEach(() => d1.close());

const TRIP_SCOPES = 'trips:read trips:write';
const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const WEB_REDIRECT = 'https://web.example.test/cb';

interface Case { clientId: string; redirect: string; url: string; env: Record<string, string> }

/** 授權請求要通過各環境的 mobile 閘門；web 沒有註冊 redirect（第一方直接換 code），測試時補一個只為了走到 scope 檢查。 */
const CASES: Case[] = [
  { clientId: 'tripline-mobile', redirect: MOBILE_PROD_REDIRECT, url: 'https://api.example.test', env: { ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.example.test' } },
  { clientId: 'tripline-mobile-uat', redirect: MOBILE_UAT_REDIRECT, url: 'https://uat-api.example.test', env: { ENVIRONMENT: 'preview', PUBLIC_ORIGIN: 'https://uat-api.example.test' } },
  { clientId: 'tripline-mobile-dev', redirect: MOBILE_DEV_REDIRECT, url: 'http://127.0.0.1:8787', env: { ENVIRONMENT: 'development' } },
  { clientId: 'tripline-web', redirect: WEB_REDIRECT, url: 'https://api.example.test', env: { ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.example.test' } },
];

function authorize(c: Case, scope: string) {
  const env = { DB: d1.db, ALLOWED_ORIGINS: '', WEB_ORIGIN: 'https://web.example.test', ...c.env } as Env;
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: c.redirect, scope, state: 's1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  });
  return app.request(`${c.url}/api/oauth/authorize?${q}`, {}, env);
}

describe('第一方 client 可請求行程 scope', () => {
  for (const c of CASES) {
    it(`${c.clientId}：請求 openid + 行程 scope → 302 到授權畫面（不是 invalid_scope）`, async () => {
      if (c.clientId === 'tripline-web') d1.raw.prepare("UPDATE client_apps SET redirect_uris = ? WHERE client_id = 'tripline-web'").run(JSON.stringify([WEB_REDIRECT]));
      const res = await authorize(c, `openid offline_access ${TRIP_SCOPES}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/oauth/authorize?request_id=');
    });

    it(`${c.clientId}：allowed_scopes 保留原本四個並加上兩個行程 scope`, () => {
      const row = d1.raw.prepare('SELECT allowed_scopes FROM client_apps WHERE client_id = ?').get(c.clientId) as { allowed_scopes: string };
      expect((JSON.parse(row.allowed_scopes) as string[]).sort()).toEqual([...BASE_SCOPES, 'trips:read', 'trips:write'].sort());
    });
  }
});

describe('migration 冪等', () => {
  it('重複套用：allowed_scopes 不重複加、不動其他欄位', () => {
    const snap = () => d1.raw.prepare("SELECT client_id, allowed_scopes, redirect_uris, status FROM client_apps ORDER BY client_id").all();
    const before = snap();
    const f = fs.readdirSync(path.join(__dirname, '../migrations')).find((x) => /^\d{4}_client_apps_trip_scopes\.sql$/.test(x))!;
    d1.raw.exec(fs.readFileSync(path.join(__dirname, '../migrations', f), 'utf8'));
    expect(snap()).toEqual(before);
  });
});

describe('其他 client 不受影響', () => {
  it('第三方自助註冊 client（四個基本 scope）請求行程 scope → invalid_scope（redirect 帶 error）', async () => {
    d1.raw.prepare("INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status) VALUES ('third-party', NULL, 'public', 'Third', ?, ?, 'active')")
      .run(JSON.stringify([WEB_REDIRECT]), JSON.stringify(BASE_SCOPES));
    const res = await authorize({ clientId: 'third-party', redirect: WEB_REDIRECT, url: 'https://api.example.test', env: { ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.example.test' } }, `openid ${TRIP_SCOPES}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });

  it('migration 只動這四個 client：其他既有 client 的 allowed_scopes 不含行程 scope', () => {
    const others = d1.raw.prepare("SELECT client_id, allowed_scopes FROM client_apps WHERE client_id NOT IN ('tripline-web','tripline-mobile','tripline-mobile-uat','tripline-mobile-dev')").all() as Array<{ client_id: string; allowed_scopes: string }>;
    for (const r of others) expect(JSON.parse(r.allowed_scopes), r.client_id).not.toContain('trips:read');
  });
});

describe('token 的 scope 決定能不能讀行程', () => {
  const readTrip = (token: string) => {
    const env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
    return app.request('/api/trips/t1', { headers: { Authorization: `Bearer ${token}` } }, env);
  };
  beforeEach(() => {
    d1.raw.prepare("INSERT INTO users (id, email) VALUES ('m', 'm@example.com')").run();
    d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id) VALUES ('t1', 'T1', 'm')").run();
    d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('m', 't1', 'member')").run();
    const ins = d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, ?)");
    const mk = (id: string, scopes: string[]) => ins.run(id, JSON.stringify({ client_id: 'tripline-mobile', user_id: 'm', scopes, grantId: `g-${id}` }), Date.now() + 3600_000);
    mk('with-scope', [...BASE_SCOPES, 'trips:read', 'trips:write']);
    mk('without-scope', BASE_SCOPES);
  });

  it('mobile token 帶 trips:read／write → 讀得到自己是 member 的行程', async () => {
    expect((await readTrip('with-scope')).status).toBe(200);
  });
  it('mobile token 不帶行程 scope → 403 PERM_DENIED（資源伺服器沒有對 mobile client 豁免）', async () => {
    const res = await readTrip('without-scope');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERM_DENIED');
  });
});
