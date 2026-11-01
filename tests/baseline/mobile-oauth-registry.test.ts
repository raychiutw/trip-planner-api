/**
 * mobile client 的註冊（migration 0097）：自舊入口 tests/api/mobile-oauth-callback.test.ts 的「registers exact callbacks」案例移植。
 * 該檔其餘案例（authorize／token 的 mobile 環境政策、PKCE 往返）已移到 mobile-oauth-gate.test.ts；migration 重跑冪等取自 mobile-oauth-migration.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { MOBILE_PROD_REDIRECT, MOBILE_UAT_REDIRECT } from '../../src/lib/mobile-oauth';

let db: D1Database;
beforeAll(async () => { db = await createTestDb(); }, 30000);
afterAll(disposeMiniflare);

describe('mobile OAuth callback 註冊', () => {
  it('精確的 production 與 UAT callback 以 public client 註冊在 D1（第一方）', async () => {
    const prod = await db.prepare('SELECT client_type, redirect_uris, first_party FROM client_apps WHERE client_id = ?')
      .bind('tripline-mobile').first<{ client_type: string; redirect_uris: string; first_party: number }>();
    const uat = await db.prepare('SELECT client_type, redirect_uris, first_party FROM client_apps WHERE client_id = ?')
      .bind('tripline-mobile-uat').first<{ client_type: string; redirect_uris: string; first_party: number }>();
    expect(prod?.client_type).toBe('public');
    expect(JSON.parse(prod!.redirect_uris)).toContain(MOBILE_PROD_REDIRECT);
    expect(uat?.client_type).toBe('public');
    expect(JSON.parse(uat!.redirect_uris)).toEqual([MOBILE_UAT_REDIRECT]);
    expect([prod!.first_party, uat!.first_party], 'requireAccountUser 只收第一方 client').toEqual([1, 1]);
  });

  it('0097 重跑（已套用的狀態）：不追加重複 URI、不新增重複 client，營運端自己加的 URI 保留；migration 的 URI 與 runtime 契約是同一組', async () => {
    const forward = fs.readFileSync(path.join(__dirname, '../../migrations/0097_mobile_oauth_callbacks.sql'), 'utf8');
    expect(forward).toContain(MOBILE_PROD_REDIRECT);
    expect(forward).toContain(MOBILE_UAT_REDIRECT);
    expect(forward).not.toMatch(/\*/); // 不得有 wildcard
    const redirects = async () => JSON.parse((await db.prepare("SELECT redirect_uris FROM client_apps WHERE client_id = 'tripline-mobile'").first<{ redirect_uris: string }>())!.redirect_uris) as string[];
    const original = await redirects();
    try {
      await db.prepare("UPDATE client_apps SET redirect_uris = ? WHERE client_id = 'tripline-mobile'").bind(JSON.stringify([...original, 'https://operator.example/cb'])).run();
      for (const stmt of forward.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
      const after = await redirects();
      expect(after.filter((u) => u === MOBILE_PROD_REDIRECT)).toHaveLength(1);
      expect(after).toContain('https://operator.example/cb');
      const n = await db.prepare("SELECT COUNT(*) AS n FROM client_apps WHERE client_id IN ('tripline-mobile-uat','tripline-mobile-dev')").first<{ n: number }>();
      expect(n!.n).toBe(2);
    } finally {
      await db.prepare("UPDATE client_apps SET redirect_uris = ? WHERE client_id = 'tripline-mobile'").bind(JSON.stringify(original)).run();
    }
  });
});
