/**
 * /api/account/sessions + /sessions/:sid — 「已登入裝置」
 *
 * ⚠ 行為變更（api 拆分）：舊測試用 cookie session + session_devices；新 api 沒有 cookie，
 * 改為「以 OAuth grant 為單位的連線」（oauth_models 的 AccessToken／RefreshToken 以 grantId 分組）。
 * 原本每條斷言都有對應的等價斷言（401、只列自己的、不含已撤銷的、撤銷其他、跨使用者撤銷不生效、
 * 撤銷後該憑證失效）；舊的「ip 雜湊前 8 碼」改為「恆為 null」（oauth_models 不記 IP）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor } from './account-session-helper';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

// 共用 D1：專用 id／email，結束時清掉自己的資料
const U1 = 'sess-user-1';
const U2 = 'sess-user-2';
const EMAIL1 = 'sess-user-1@example.com';
const EMAIL2 = 'sess-user-2@example.com';

let db: D1Database;
let api: Api;

interface SessionJson {
  sid: string; client_id: string; ua_summary: string; ip_hash_prefix: string | null;
  created_at: string; last_seen_at: string; is_current: boolean;
}

async function tokenRows(grantId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT count(*) AS n FROM oauth_models WHERE name IN ('AccessToken','RefreshToken') AND json_extract(payload, '$.grantId') = ?`,
  ).bind(grantId).first<{ n: number }>();
  return row!.n;
}

async function cleanGrants() {
  await db.prepare(`DELETE FROM oauth_models WHERE json_extract(payload, '$.user_id') IN (?, ?)`).bind(U1, U2).run();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
}, 30000);

beforeEach(cleanGrants);

afterAll(async () => {
  await cleanGrants();
  await db.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(U1, U2).run();
  await disposeMiniflare();
});

describe('GET /api/account/sessions', () => {
  it('401 when no bearer', async () => {
    const res = await api.get('/api/account/sessions');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('200 returns grants list with current marked', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    const old = await sessionFor(db, EMAIL1, U1); // 另一個 grant（例如另一台裝置）

    const res = await api.get('/api/account/sessions', { bearer: me.bearer });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { current_sid: string | null; sessions: SessionJson[] };
    expect(json.current_sid).toBe(me.grantId);
    // access + refresh 同 grant 只算一筆
    expect(json.sessions).toHaveLength(2);
    expect(json.sessions.filter((s) => s.is_current).map((s) => s.sid)).toEqual([me.grantId]);
    const other = json.sessions.find((s) => s.sid === old.grantId)!;
    expect(other.is_current).toBe(false);
    expect(other.client_id).toBe('tripline-web');
    expect(other.ua_summary).toBe('Tripline Web'); // client_apps.app_name
    expect(other.ip_hash_prefix).toBeNull();
    expect(Number.isNaN(Date.parse(other.created_at))).toBe(false);
  });

  it('只列自己的有效 grant（不含別人的、不含過期的、不含 client_credentials）', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    await sessionFor(db, EMAIL2, U2);
    // 過期的 grant
    await new D1Adapter(db, 'AccessToken').upsert('sess-expired', { client_id: 'tripline-web', user_id: U1, scopes: [], grantId: 'g-expired' }, -10);
    // 沒有 user 的 service token
    await new D1Adapter(db, 'AccessToken').upsert('sess-svc', { client_id: 'svc', user_id: null, scopes: ['ops:read'], grantId: 'g-svc' }, 3600);

    const res = await api.get('/api/account/sessions', { bearer: me.bearer });
    const json = (await res.json()) as { sessions: SessionJson[] };
    expect(json.sessions.map((s) => s.sid)).toEqual([me.grantId]);
    await db.prepare(`DELETE FROM oauth_models WHERE id IN ('sess-expired','sess-svc')`).run();
  });

  it('service token（無使用者）→ 401；受限 token → 403', async () => {
    await new D1Adapter(db, 'AccessToken').upsert('sess-svc2', { client_id: 'svc', user_id: null, scopes: ['ops:read'], grantId: 'g-svc2' }, 3600);
    expect((await api.get('/api/account/sessions', { bearer: 'sess-svc2' })).status).toBe(401);
    const restricted = await sessionFor(db, EMAIL1, U1, { restrictTrip: 't1' });
    expect((await api.get('/api/account/sessions', { bearer: restricted.bearer })).status).toBe(403);
    await db.prepare(`DELETE FROM oauth_models WHERE id = 'sess-svc2'`).run();
  });
});

describe('DELETE /api/account/sessions (revoke all others)', () => {
  it('401 when no bearer', async () => {
    const res = await api.request('DELETE', '/api/account/sessions');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('200 + revokes all other grants for current user, keeps current and others\' grants', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    const a = await sessionFor(db, EMAIL1, U1);
    const b = await sessionFor(db, EMAIL1, U1);
    const c = await sessionFor(db, EMAIL1, U1);
    const theirs = await sessionFor(db, EMAIL2, U2);

    const res = await api.request('DELETE', '/api/account/sessions', { bearer: me.bearer });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revoked: number };
    expect(json.ok).toBe(true);
    expect(json.revoked).toBe(3);

    for (const g of [a, b, c]) expect(await tokenRows(g.grantId)).toBe(0);
    // 自己這個 grant 與別人的都不動
    expect(await tokenRows(me.grantId)).toBe(2);
    expect(await tokenRows(theirs.grantId)).toBe(2);
  });
});

describe('DELETE /api/account/sessions/:sid (revoke specific grant)', () => {
  it('401 when no bearer', async () => {
    const res = await api.request('DELETE', '/api/account/sessions/sid-x');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('sid 為空（結尾斜線）→ 沒有登記該路徑，404，且不會撤銷任何 grant', async () => {
    // 行為差異：舊入口的結尾斜線會落到「登出其他裝置」；新 api 不登記，避免誤傷。
    const me = await sessionFor(db, EMAIL1, U1);
    const a = await sessionFor(db, EMAIL1, U1);
    const res = await api.request('DELETE', '/api/account/sessions/', { bearer: me.bearer });
    expect(res.status).toBe(404);
    expect(await tokenRows(a.grantId)).toBe(2);
  });

  it("404 SESSION_NOT_FOUND when sid doesn't belong to user（跨使用者撤銷不得生效）", async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    const theirs = await sessionFor(db, EMAIL2, U2);

    const res = await api.request('DELETE', `/api/account/sessions/${theirs.grantId}`, { bearer: me.bearer });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SESSION_NOT_FOUND');
    expect(await tokenRows(theirs.grantId)).toBe(2);
  });

  it('200 + 刪除該 grant 的 access 與 refresh token，只動指定的那一個', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    const target = await sessionFor(db, EMAIL1, U1);
    const keep = await sessionFor(db, EMAIL1, U1);

    const res = await api.request('DELETE', `/api/account/sessions/${target.grantId}`, { bearer: me.bearer });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revoked_sid: string };
    expect(json.ok).toBe(true);
    expect(json.revoked_sid).toBe(target.grantId);

    expect(await tokenRows(target.grantId)).toBe(0);
    expect(await tokenRows(keep.grantId)).toBe(2);
  });

  it('已撤銷的 grant 再撤銷一次 → 404', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    const target = await sessionFor(db, EMAIL1, U1);
    expect((await api.request('DELETE', `/api/account/sessions/${target.grantId}`, { bearer: me.bearer })).status).toBe(200);
    expect((await api.request('DELETE', `/api/account/sessions/${target.grantId}`, { bearer: me.bearer })).status).toBe(404);
  });

  it('被撤銷的 grant 的 access token 之後即失效（401），其他不受影響', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    const other = await sessionFor(db, EMAIL1, U1);
    expect((await api.request('DELETE', `/api/account/sessions/${other.grantId}`, { bearer: me.bearer })).status).toBe(200);
    expect((await api.get('/api/account/sessions', { bearer: other.bearer })).status).toBe(401);
    expect((await api.get('/api/account/sessions', { bearer: me.bearer })).status).toBe(200);
  });

  it('可撤銷自己當前的 grant（等同登出）：之後同一個 token 失效', async () => {
    const me = await sessionFor(db, EMAIL1, U1);
    expect((await api.request('DELETE', `/api/account/sessions/${me.grantId}`, { bearer: me.bearer })).status).toBe(200);
    expect((await api.get('/api/account/sessions', { bearer: me.bearer })).status).toBe(401);
  });
});
