/**
 * mobile client 的註冊（migration 0097）：自舊入口 tests/api/mobile-oauth-callback.test.ts 的「registers exact callbacks」案例移植。
 * 該檔其餘案例（authorize／consent／token 的 mobile 環境政策、PKCE 往返）屬於 mobile OAuth 的環境閘門，
 * 不在這次帳號刪除 fresh-auth 的範圍，沒有移植（見 PR 說明）。
 */
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
});
