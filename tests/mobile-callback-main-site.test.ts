/**
 * mobile callback 搬到 web 主站（raychiutw/trip-planner#1482）後的契約：
 * 每個環境只接受主站路徑的精確 redirect，不開 wildcard、不跨環境；舊 callback（mobile-callback 分支別名）已退役（#1663）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createD1 } from './support/d1';
import {
  MOBILE_DEV_REDIRECT,
  MOBILE_PROD_REDIRECT,
  MOBILE_UAT_REDIRECT,
  mobileClientAllowed,
  mobileOAuthContract,
} from '../src/lib/mobile-oauth';
import type { Env } from '../src/env';

const NEW_PROD = 'https://trip-planner-dby.pages.dev/mobile/oauth/callback';
const NEW_UAT = 'https://trip-planner-dby.pages.dev/mobile/uat/oauth/callback';
const OLD_PROD = 'https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback';
const OLD_UAT = 'https://mobile-callback.trip-planner-dby.pages.dev/uat/oauth/callback';

const at = (url: string) => new Request(`${url}/api/oauth/authorize`);
const prodEnv = { ENVIRONMENT: 'production', PUBLIC_ORIGIN: 'https://api.prod.test' } as unknown as Env;
const uatEnv = { ENVIRONMENT: 'preview', PUBLIC_ORIGIN: 'https://api.stg.test' } as unknown as Env;
const devEnv = { ENVIRONMENT: 'development' } as unknown as Env;
const prod = (uri?: string | null) => mobileClientAllowed(prodEnv, at('https://api.prod.test'), 'tripline-mobile', uri);
const uat = (uri?: string | null) => mobileClientAllowed(uatEnv, at('https://api.stg.test'), 'tripline-mobile-uat', uri);
const dev = (uri?: string | null) => mobileClientAllowed(devEnv, at('http://localhost:8788'), 'tripline-mobile-dev', uri);

describe('常數', () => {
  it('主站兩組的字面值固定（Flutter／web 的 AASA 以此為準）', () => {
    expect([MOBILE_PROD_REDIRECT, MOBILE_UAT_REDIRECT]).toEqual([NEW_PROD, NEW_UAT]);
  });
});

describe('mobileClientAllowed：只收主站 callback，舊 callback 被拒', () => {
  it('production：主站放行、舊 callback 被拒', () => {
    expect(prod(NEW_PROD)).toBe(true);
    expect(prod(OLD_PROD)).toBe(false);
  });
  it('UAT：主站放行、舊 callback 被拒', () => {
    expect(uat(NEW_UAT)).toBe(true);
    expect(uat(OLD_UAT)).toBe(false);
  });
  it('dev 不變：只收 loopback', () => {
    expect(dev(MOBILE_DEV_REDIRECT)).toBe(true);
    expect(dev(NEW_PROD)).toBe(false);
    expect(dev(OLD_PROD)).toBe(false);
  });
  it('跨環境被拒：production 不收 UAT 的新／舊，UAT 不收 production 的新／舊', () => {
    for (const u of [NEW_UAT, OLD_UAT, MOBILE_DEV_REDIRECT]) expect(prod(u), u).toBe(false);
    for (const u of [NEW_PROD, OLD_PROD, MOBILE_DEV_REDIRECT]) expect(uat(u), u).toBe(false);
  });
  it('任意相似網址與 wildcard 被拒（精確相等，不是前綴、不是正規化後相等）', () => {
    const lookalikes = [
      `${NEW_PROD}/`, `${NEW_PROD}?x=1`, `${NEW_PROD}#f`, `${NEW_PROD}/extra`, `${NEW_PROD}x`,
      NEW_PROD.replace('https:', 'http:'), NEW_PROD.replace('/mobile/oauth', '/MOBILE/oauth'),
      'https://trip-planner-dby.pages.dev.evil.test/mobile/oauth/callback',
      'https://evil.test/mobile/oauth/callback', 'https://trip-planner-dby.pages.dev@evil.test/mobile/oauth/callback',
      'https://*.trip-planner-dby.pages.dev/mobile/oauth/callback', 'https://trip-planner-dby.pages.dev/*',
      'https://preview.trip-planner-dby.pages.dev/mobile/oauth/callback',
      'https://trip-planner-dby.pages.dev/oauth/callback', 'https://trip-planner-dby.pages.dev/auth/callback',
      `${OLD_PROD}/`, `${OLD_PROD}?x=1`, 'https://other.trip-planner-dby.pages.dev/oauth/callback', '', '*',
    ];
    for (const u of lookalikes) expect(prod(u), u).toBe(false);
    for (const u of lookalikes.map((x) => x.replace('/oauth/callback', '/uat/oauth/callback'))) expect(uat(u), u).toBe(false);
  });
  it('mobileOAuthContract：redirectUri 是新的偏好值，redirectUris 是該環境的允許集合', () => {
    expect(mobileOAuthContract(prodEnv, at('https://api.prod.test'))).toEqual({ clientId: 'tripline-mobile', redirectUri: NEW_PROD, redirectUris: [NEW_PROD] });
    expect(mobileOAuthContract(uatEnv, at('https://api.stg.test'))).toEqual({ clientId: 'tripline-mobile-uat', redirectUri: NEW_UAT, redirectUris: [NEW_UAT] });
    expect(mobileOAuthContract(devEnv, at('http://localhost:8788'))).toEqual({ clientId: 'tripline-mobile-dev', redirectUri: MOBILE_DEV_REDIRECT, redirectUris: [MOBILE_DEV_REDIRECT] });
  });
});

describe('migration 0104：追加主站 callback（additive、冪等、不覆寫營運端資料）', () => {
  let d1: ReturnType<typeof createD1>;
  afterEach(() => { try { d1?.close(); } catch { /* 未開庫的案例 */ } });
  const FILE = '0104_client_apps_mobile_main_site_callback.sql';
  const sql = () => fs.readFileSync(path.join(__dirname, '../migrations', FILE), 'utf8');
  const uris = (id: string) => {
    const r = d1.raw.prepare('SELECT redirect_uris FROM client_apps WHERE client_id = ?').get(id) as { redirect_uris: string } | undefined;
    return r ? (JSON.parse(r.redirect_uris) as string[]) : undefined;
  };

  it('舊值保留、新值追加；dev client 不動', () => {
    d1 = createD1({ through: 103 });
    const devBefore = uris('tripline-mobile-dev');
    d1.raw.exec(sql());
    expect(uris('tripline-mobile')).toEqual(expect.arrayContaining([OLD_PROD, NEW_PROD]));
    expect(uris('tripline-mobile-uat')).toEqual([OLD_UAT, NEW_UAT]);
    expect(uris('tripline-mobile-dev')).toEqual(devBefore);
  });
  it('production 不會被塞進 UAT 的 URI，UAT 也不會被塞進 production 的', () => {
    d1 = createD1();
    expect(uris('tripline-mobile')).not.toContain(NEW_UAT);
    expect(uris('tripline-mobile-uat')).not.toContain(NEW_PROD);
  });
  it('重跑冪等：不重複追加', () => {
    d1 = createD1();
    d1.raw.exec(sql());
    d1.raw.exec(sql());
    for (const [id, u] of [['tripline-mobile', NEW_PROD], ['tripline-mobile-uat', NEW_UAT]] as const) {
      expect(uris(id)!.filter((x) => x === u)).toHaveLength(1);
    }
  });
  it('營運端自己加的 URI 保留；其他 client 與格式壞掉的值不被動到', () => {
    d1 = createD1({ through: 103 });
    d1.raw.prepare("UPDATE client_apps SET redirect_uris = ? WHERE client_id = 'tripline-mobile'").run(JSON.stringify([OLD_PROD, 'https://operator.example/cb']));
    d1.raw.prepare("INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes) VALUES ('partner', 'public', 'p', '[\"https://p.example/cb\"]', '[]')").run();
    d1.raw.prepare("UPDATE client_apps SET redirect_uris = 'not-json' WHERE client_id = 'tripline-mobile-uat'").run();
    d1.raw.exec(sql());
    expect(uris('tripline-mobile')).toEqual([OLD_PROD, 'https://operator.example/cb', NEW_PROD]);
    expect(uris('partner')).toEqual(['https://p.example/cb']);
    expect((d1.raw.prepare("SELECT redirect_uris FROM client_apps WHERE client_id = 'tripline-mobile-uat'").get() as { redirect_uris: string }).redirect_uris).toBe('not-json');
  });
  it('只有加法：沒有 DELETE／DROP、沒有 wildcard、不碰 0097 已登記的舊值', () => {
    const body = sql().replace(/--[^\n]*/g, '');
    expect(body).not.toMatch(/\b(DELETE|DROP|ALTER)\b/i);
    expect(body).not.toMatch(/\*/);
    expect(body).not.toContain('mobile-callback.trip-planner-dby.pages.dev');
  });
});

describe('migration 0105：移除舊 callback（只 UPDATE、冪等、只移除指定值）', () => {
  let d1: ReturnType<typeof createD1>;
  afterEach(() => { try { d1?.close(); } catch { /* 未開庫的案例 */ } });
  const FILE = '0105_client_apps_remove_legacy_mobile_callback.sql';
  const sql = () => fs.readFileSync(path.join(__dirname, '../migrations', FILE), 'utf8');
  const raw = (id: string) => (d1.raw.prepare('SELECT redirect_uris FROM client_apps WHERE client_id = ?').get(id) as { redirect_uris: string } | undefined)?.redirect_uris;
  const uris = (id: string) => JSON.parse(raw(id)!) as string[];

  it('套用後 tripline-mobile／-uat 只剩主站網址；dev client 不動', () => {
    d1 = createD1({ through: 104 });
    const devBefore = raw('tripline-mobile-dev');
    expect(uris('tripline-mobile')).toContain(OLD_PROD); // 前置：舊值確實在
    d1.raw.exec(sql());
    expect(uris('tripline-mobile')).toEqual([NEW_PROD]);
    expect(uris('tripline-mobile-uat')).toEqual([NEW_UAT]);
    expect(raw('tripline-mobile-dev')).toBe(devBefore);
  });
  it('重跑冪等', () => {
    d1 = createD1({ through: 104 });
    d1.raw.exec(sql());
    const once = [raw('tripline-mobile'), raw('tripline-mobile-uat')];
    d1.raw.exec(sql());
    expect([raw('tripline-mobile'), raw('tripline-mobile-uat')]).toEqual(once);
  });
  it('只移除指定值：營運端自加的 URI、loopback、其他 client、格式壞掉的值都保留', () => {
    d1 = createD1({ through: 104 });
    d1.raw.prepare("UPDATE client_apps SET redirect_uris = ? WHERE client_id = 'tripline-mobile'").run(JSON.stringify([OLD_PROD, 'http://127.0.0.1:8765', NEW_PROD, 'https://operator.example/cb']));
    d1.raw.prepare("INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes) VALUES ('partner', 'public', 'p', ?, '[]')").run(JSON.stringify([OLD_PROD]));
    d1.raw.prepare("UPDATE client_apps SET redirect_uris = 'not-json' WHERE client_id = 'tripline-mobile-uat'").run();
    d1.raw.exec(sql());
    expect(uris('tripline-mobile')).toEqual(['http://127.0.0.1:8765', NEW_PROD, 'https://operator.example/cb']);
    expect(uris('partner')).toEqual([OLD_PROD]);
    expect(raw('tripline-mobile-uat')).toBe('not-json');
  });
  it('沒有 DELETE／DROP／ALTER／INSERT、沒有 wildcard', () => {
    const body = sql().replace(/--[^\n]*/g, '');
    expect(body).not.toMatch(/\b(DELETE|DROP|ALTER|INSERT)\b/i);
    expect(body).not.toMatch(/\*/);
  });
});
