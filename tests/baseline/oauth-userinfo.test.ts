/**
 * GET /api/oauth/userinfo — V2-P1
 * 走 HTTP 邊界。行為變更：新 api 沒有 cookie session，改認 bearer access token（須對應使用者）；
 * 舊測試中依賴 session cookie／本機 mock auth 的部分改寫為 bearer 等價表達。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const PATH = 'https://x.com/api/oauth/userinfo';
// 專用 email：共用 D1 下只動自己的資料列
const email = (name: string) => `userinfo-${name}@http-test.example`;
const EMAILS = ['full', 'unverified', 'ghost', 'alpha', 'beta'].map(email);

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
});

afterAll(async () => {
  const ids = EMAILS.map(userIdFor);
  for (const id of ids) {
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await db.prepare("DELETE FROM oauth_models WHERE id = 'userinfo-service-token'").run();
  await disposeMiniflare();
});

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

const who = async (name: string) => {
  const bearer = await api.tokenFor(email(name));
  return { bearer, userId: userIdFor(email(name)) };
};

describe('GET /api/oauth/userinfo', () => {
  it('401 AUTH_REQUIRED when no bearer', async () => {
    const res = await api.get(PATH);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('AUTH_REQUIRED');
  });

  it('401 AUTH_REQUIRED when bearer token invalid', async () => {
    const res = await api.get(PATH, { bearer: 'tampered-token' });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('AUTH_REQUIRED');
  });

  it('returns 200 + user payload when bearer valid + user exists', async () => {
    const { bearer, userId } = await who('full');
    await db
      .prepare('UPDATE users SET display_name = ?, avatar_url = ?, email_verified_at = ?, created_at = ? WHERE id = ?')
      .bind('Me', 'https://avatar.example.com/me.png', '2026-04-25T00:00:00.000Z', '2026-04-20T00:00:00.000Z', userId)
      .run();
    const res = await api.get(PATH, { bearer });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({
      id: userId,
      email: email('full'),
      emailVerified: true,
      displayName: 'Me',
      avatarUrl: 'https://avatar.example.com/me.png',
      createdAt: '2026-04-20T00:00:00.000Z',
    });
  });

  it('emailVerified = false when email_verified_at is null', async () => {
    const { bearer, userId } = await who('unverified');
    await db
      .prepare('UPDATE users SET display_name = NULL, avatar_url = NULL, email_verified_at = NULL, created_at = ? WHERE id = ?')
      .bind('2026-04-25', userId)
      .run();
    const json = await (await api.get(PATH, { bearer })).json() as { emailVerified: boolean; displayName: null; avatarUrl: null; createdAt: string };
    expect(json.emailVerified).toBe(false);
    expect(json.displayName).toBeNull();
    expect(json.avatarUrl).toBeNull();
    // created_at 沒帶 Z 時由 handler 補上
    expect(json.createdAt).toBe('2026-04-25Z');
  });

  it('401 when the token\'s user row is gone (deleted user)', async () => {
    const { bearer, userId } = await who('ghost');
    await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    const res = await api.get(PATH, { bearer });
    expect(res.status).toBe(401); // bearer 驗證對不存在的使用者 fail-closed
  });

  it('service token (bearer without user) → 401 AUTH_REQUIRED（不可拿 null 去查 users）', async () => {
    await new D1Adapter(db, 'AccessToken').upsert(
      'userinfo-service-token',
      { client_id: 'userinfo-service', user_id: null, scopes: ['admin'], grantId: 'grant-userinfo-service' },
      300,
    );
    const res = await api.get(PATH, { bearer: 'userinfo-service-token' });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('AUTH_REQUIRED');
  });

  it('returns the row of the bearer user, not another user', async () => {
    const alpha = await who('alpha');
    const beta = await who('beta');
    const a = await (await api.get(PATH, { bearer: alpha.bearer })).json() as { id: string; email: string };
    const b = await (await api.get(PATH, { bearer: beta.bearer })).json() as { id: string; email: string };
    expect(a).toMatchObject({ id: alpha.userId, email: email('alpha') });
    expect(b).toMatchObject({ id: beta.userId, email: email('beta') });
  });
});
