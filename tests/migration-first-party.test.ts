/**
 * 0097／0098（自 web 同步，已套用於 staging 與 production）與 0099（client_apps.first_party）。
 * 用真 SQLite 套用全部 migrations，驗證結果的資料形狀。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
afterEach(() => d1?.close());

type Client = { client_id: string; client_type: string; status: string; first_party: number; redirect_uris: string; allowed_scopes: string };
const clients = () => d1.raw.prepare('SELECT client_id, client_type, status, first_party, redirect_uris, allowed_scopes FROM client_apps').all() as Client[];

describe('0099 client_apps.first_party', () => {
  it('欄位存在、預設 0、不可為 NULL（新註冊的第三方 client 預設不是第一方）', () => {
    d1 = createD1();
    d1.raw.prepare("INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes) VALUES ('third', 'public', 't', '[]', '[]')").run();
    expect((d1.raw.prepare("SELECT first_party FROM client_apps WHERE client_id = 'third'").get() as { first_party: number }).first_party).toBe(0);
    expect(() => d1.raw.prepare("UPDATE client_apps SET first_party = NULL WHERE client_id = 'third'").run()).toThrow();
  });

  it('只允許 0 或 1', () => {
    d1 = createD1();
    d1.raw.prepare("INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes) VALUES ('third', 'public', 't', '[]', '[]')").run();
    expect(() => d1.raw.prepare("UPDATE client_apps SET first_party = 2 WHERE client_id = 'third'").run()).toThrow();
  });

  it('tripline-web 與三個行動端 client 是第一方、public、啟用', () => {
    d1 = createD1();
    const byId = new Map(clients().map((c) => [c.client_id, c]));
    for (const id of ['tripline-web', 'tripline-mobile', 'tripline-mobile-uat', 'tripline-mobile-dev']) {
      const c = byId.get(id);
      expect(c, id).toBeDefined();
      expect(c).toMatchObject({ client_type: 'public', status: 'active', first_party: 1 });
      expect(JSON.parse(c!.allowed_scopes)).toEqual(expect.arrayContaining(['openid', 'profile', 'email']));
    }
  });

  it('除了這四個之外沒有任何 client 被標成第一方（不會誤放行）', () => {
    d1 = createD1();
    const firstParty = clients().filter((c) => c.first_party === 1).map((c) => c.client_id).sort();
    expect(firstParty).toEqual(['tripline-mobile', 'tripline-mobile-dev', 'tripline-mobile-uat', 'tripline-web']);
  });

  it('套用當下已存在的第三方 client 不會被標成第一方（升級既有資料庫的情境）', () => {
    d1 = createD1({ through: 98 });
    d1.raw.prepare("INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, status) VALUES ('partner', 'public', 'p', '[\"https://p.example/cb\"]', '[\"openid\"]', 'active')").run();
    d1.applyMigrationsAfter(98);
    const byId = new Map(clients().map((c) => [c.client_id, c]));
    expect(byId.get('partner')!.first_party).toBe(0);
    expect(byId.get('tripline-mobile')!.first_party).toBe(1);
  });

  it('tripline-web 是 public client（沒有 secret），且不註冊任何 redirect_uri（第一方直接換 code，不走跳轉）', () => {
    d1 = createD1();
    const row = d1.raw.prepare("SELECT client_secret_hash, redirect_uris FROM client_apps WHERE client_id = 'tripline-web'").get() as { client_secret_hash: string | null; redirect_uris: string };
    expect(row.client_secret_hash).toBeNull();
    expect(JSON.parse(row.redirect_uris)).toEqual([]);
  });
});

describe('同步自 web 的 0097／0098', () => {
  it('0097：行動端註冊 app-link callback，且重複套用不會重複加入', () => {
    d1 = createD1();
    const uris = JSON.parse(clients().find((c) => c.client_id === 'tripline-mobile')!.redirect_uris) as string[];
    expect(uris).toContain('https://mobile-callback.trip-planner-dby.pages.dev/oauth/callback');
    expect(new Set(uris).size).toBe(uris.length);
  });
  it('0098：oauth_models 有 user_id 的運算式索引', () => {
    d1 = createD1();
    const idx = d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_oauth_models_user_id'").get();
    expect(idx).toBeDefined();
  });
});
