/**
 * POST／GET /api/oauth/logout —— 行為變更：撤銷目前 bearer 所屬的 grant（沒有 cookie 可清）。
 * 回 204；同一 grant 的 AccessToken 與 RefreshToken 全部刪除，別的 grant／別人的不動。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const EMAIL = 'h1-logout-a@example.com';
const OTHER = 'h1-logout-b@example.com';
const PATH = 'https://x.com/api/oauth/logout';

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});
afterAll(async () => {
  await db.prepare("DELETE FROM oauth_models WHERE id LIKE 'h1-logout-%'").run();
  await db.prepare("DELETE FROM auth_audit_log WHERE user_id IN (?, ?)").bind(userIdFor(EMAIL), userIdFor(OTHER)).run();
  await disposeMiniflare();
});

/** 發一組 access + refresh（同 grant），回傳兩個 token。 */
async function session(email: string, grantId: string) {
  const userId = userIdFor(email);
  await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(userId, email, 'u').run();
  const access = `h1-logout-at-${crypto.randomUUID()}`;
  const refresh = `h1-logout-rt-${crypto.randomUUID()}`;
  await new D1Adapter(db, 'AccessToken').upsert(access, { client_id: 'c', user_id: userId, scopes: ['openid'], grantId }, 300);
  await new D1Adapter(db, 'RefreshToken').upsert(refresh, { client_id: 'c', user_id: userId, scopes: ['openid'], grantId }, 300);
  return { access, refresh };
}
const exists = async (name: string, id: string) => (await new D1Adapter(db, name).find(id)) !== undefined;

describe('/api/oauth/logout', () => {
  it('沒有 bearer → 401', async () => {
    expect((await api.request('POST', PATH)).status).toBe(401);
    expect((await api.get(PATH)).status).toBe(401);
  });

  it('POST：撤銷自己的 grant（access 與 refresh 都刪）→ 204；token 立刻失效', async () => {
    const s = await session(EMAIL, 'h1-logout-g1');
    const res = await api.request('POST', PATH, { bearer: s.access });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await exists('AccessToken', s.access)).toBe(false);
    expect(await exists('RefreshToken', s.refresh)).toBe(false);
    expect((await api.get('https://x.com/api/oauth/userinfo', { bearer: s.access })).status).toBe(401);
  });

  it('GET 與 POST 行為相同', async () => {
    const s = await session(EMAIL, 'h1-logout-g2');
    const res = await api.get(PATH, { bearer: s.access });
    expect(res.status).toBe(204);
    expect(await exists('RefreshToken', s.refresh)).toBe(false);
  });

  it('只撤銷這一個 grant：同使用者的另一個 grant、別人的 grant 都不動', async () => {
    const mine = await session(EMAIL, 'h1-logout-g3');
    const myOther = await session(EMAIL, 'h1-logout-g3-other-device');
    const theirs = await session(OTHER, 'h1-logout-g3-theirs');
    expect((await api.request('POST', PATH, { bearer: mine.access })).status).toBe(204);
    expect(await exists('AccessToken', myOther.access)).toBe(true);
    expect(await exists('RefreshToken', myOther.refresh)).toBe(true);
    expect(await exists('AccessToken', theirs.access)).toBe(true);
    expect(await exists('RefreshToken', theirs.refresh)).toBe(true);
  });

  it('不收請求參數指定 grant（帶別人的 grant_id 無效）', async () => {
    const mine = await session(EMAIL, 'h1-logout-g4');
    const theirs = await session(OTHER, 'h1-logout-g4-theirs');
    await api.request('POST', `${PATH}?grant_id=h1-logout-g4-theirs`, { bearer: mine.access, json: { grantId: 'h1-logout-g4-theirs' } });
    expect(await exists('AccessToken', theirs.access)).toBe(true);
    expect(await exists('RefreshToken', theirs.refresh)).toBe(true);
  });

  it('記一筆 logout 稽核事件（帶使用者）', async () => {
    const s = await session(EMAIL, 'h1-logout-g5');
    const before = await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM auth_audit_log').first<{ m: number }>();
    await api.request('POST', PATH, { bearer: s.access });
    const { results } = await db.prepare('SELECT event_type, outcome, user_id FROM auth_audit_log WHERE id > ? ORDER BY id').bind(before!.m)
      .all<{ event_type: string; outcome: string; user_id: string | null }>();
    expect(results).toEqual([{ event_type: 'logout', outcome: 'success', user_id: userIdFor(EMAIL) }]);
  });

  it('已登出的 token 再登出 → 401（不重複稽核）', async () => {
    const s = await session(EMAIL, 'h1-logout-g6');
    await api.request('POST', PATH, { bearer: s.access });
    expect((await api.request('POST', PATH, { bearer: s.access })).status).toBe(401);
  });
});
