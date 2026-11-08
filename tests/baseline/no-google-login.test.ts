// @vitest-environment node
/**
 * 守門：Google 登入與 Google 重新驗證已整個移除（trip-planner#1643，owner 決議暫不做）。
 *
 * 守的是「不得復活」：路由不在 OpenAPI、不可呼叫、src 不再引用相關模組；
 * 帳號刪除對沒有密碼的帳號必須 fail-closed（不能因為少了 Google 重新驗證就變成免驗證可刪）。
 * Google Maps／Places／Routes 是地圖不是登入，刻意不在守門範圍（src/lib/maps、places、admin 的 GOOGLE_MAPS_API_KEY 等）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor } from './account-session-helper';

const ROOT = join(__dirname, '../..');

describe('Google 登入／重新驗證已移除', () => {
  let db: D1Database;
  let api: Api;

  beforeAll(async () => {
    db = await createTestDb();
    api = createApi({ env: mockEnv(db, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' } as never) });
  }, 30000);

  afterAll(async () => {
    await db.prepare(`DELETE FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND id LIKE 'ngl-%'`).run();
    await db.prepare(`DELETE FROM oauth_models WHERE json_extract(payload, '$.user_id') LIKE 'ngl-u%'`).run();
    await db.prepare(`DELETE FROM users WHERE id LIKE 'ngl-u%'`).run();
    await disposeMiniflare();
  });

  it('OpenAPI 不含 Google 登入、callback、delete-reauth', async () => {
    const spec = (await (await createApp().request('/openapi.json', {}, mockEnv(db, {}))).json()) as { paths: Record<string, unknown> };
    const hits = Object.keys(spec.paths).filter((p) => /google|delete-reauth/i.test(p));
    expect(hits).toEqual([]);
  });

  it.each([
    ['GET', '/api/oauth/login/google'],
    ['GET', '/api/oauth/callback/google'],
    ['POST', '/api/account/delete-reauth'],
    ['GET', '/api/account/delete-reauth?challenge_id=x'],
    ['DELETE', '/api/account/delete-reauth?challenge_id=x'],
  ])('%s %s 回 404（即使 env 設了 GOOGLE_CLIENT_ID）', async (method, path) => {
    const s = await sessionFor(db, 'ngl-route@example.com', 'ngl-u-route');
    const res = await api.request(method as 'GET', path, { bearer: s.bearer });
    expect(res.status).toBe(404);
  });

  it('public-config：providers.google 為相容欄位，恆為 false（web LoginPage 仍讀它）', async () => {
    const res = await api.request('GET', '/api/public-config', {});
    expect(((await res.json()) as { providers: { google: boolean } }).providers.google).toBe(false);
  });

  it('GET /api/account：reauthProvider 恆 null、reauthenticated 恆 false（相容欄位），有 Google identity 也一樣', async () => {
    const s = await sessionFor(db, 'ngl-preview@example.com', 'ngl-u-preview');
    await db.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', 'ngl-sub')").bind(s.userId).run();
    const res = await api.request('GET', '/api/account', { bearer: s.bearer });
    expect(await res.json()).toMatchObject({ hasPassword: false, reauthProvider: null, reauthenticated: false });
  });

  it('無密碼帳號：即使殘留 verified 的舊 challenge 也不能刪（fail-closed，資料不動）', async () => {
    const s = await sessionFor(db, 'ngl-nopw@example.com', 'ngl-u-nopw');
    const payload = { uid: s.userId, grantId: s.grantId, clientId: 'tripline-web', surface: 'web', status: 'verified' };
    await db.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccountDeleteChallenge', 'ngl-ch', ?, 9e15)")
      .bind(JSON.stringify(payload)).run();
    for (const body of [{ challengeId: 'ngl-ch' }, { confirm: 'DELETE', challengeId: 'ngl-ch' }, { confirm: 'DELETE' }]) {
      const res = await api.request('DELETE', '/api/account', { bearer: s.bearer, json: body });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ACCOUNT_DELETE_REAUTH_REQUIRED');
    }
    expect(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(s.userId).first()).not.toBeNull();
  });

  it('src 不再引用 google-id-token／delete-reauth／GOOGLE_CLIENT_ID／SECRET／login|callback google', () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', '-E', 'google-id-token|delete-reauth|GOOGLE_CLIENT_(ID|SECRET)|oauth/(login|callback)/google|verifyGoogleIdToken', '--', 'src', 'wrangler.toml'], { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git grep 無命中時 exit 1 */ }
    expect(out.trim().split('\n').filter(Boolean)).toEqual([]);
  });
});
