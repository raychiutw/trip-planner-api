/**
 * DELETE／PATCH /api/permissions/:id：沒有管理權的人，不能靠回應差異探測 id 是否存在、是不是 owner 列。
 * （舊入口先判斷「目標是 owner 列」才判斷呼叫者權限，所以 404／403 的差異洩漏了資訊。）
 * 走 HTTP 邊界，真 SQLite。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
const app = createApp();
let ownerRow = 0; let memberRow = 0; let viewerRow = 0;

beforeEach(() => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  const u = d1.raw.prepare('INSERT INTO users (id, email) VALUES (?, ?)');
  for (const [id, email] of [['owner', 'o@example.com'], ['member', 'm@example.com'], ['viewer', 'v@example.com'], ['stranger', 's@example.com'], ['other-owner', 'oo@example.com']]) u.run(id as string, email as string);
  d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id) VALUES ('t1', 'T1', 'owner'), ('t2', 'T2', 'other-owner')").run();
  const p = d1.raw.prepare('INSERT INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, ?)');
  ownerRow = Number(p.run('owner', 't1', 'owner').lastInsertRowid);
  memberRow = Number(p.run('member', 't1', 'member').lastInsertRowid);
  viewerRow = Number(p.run('viewer', 't1', 'viewer').lastInsertRowid);
  p.run('other-owner', 't2', 'owner');
  for (const [tok, user] of [['tok-owner', 'owner'], ['tok-member', 'member'], ['tok-stranger', 'stranger'], ['tok-other-owner', 'other-owner']]) {
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, ?)").run(tok as string, JSON.stringify({ client_id: 'web', user_id: user, scopes: ['trips:read', 'trips:write'], grantId: `g-${tok}` }), Date.now() + 3600_000);
  }
});
afterEach(() => d1.close());

const call = (method: 'DELETE' | 'PATCH', id: number | string, token: string, body?: unknown) =>
  app.request(`/api/permissions/${id}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }, env);
const rows = () => d1.raw.prepare('SELECT id, role FROM trip_permissions ORDER BY id').all();
const snapshot = async (res: Response) => ({ status: res.status, body: await res.text() });

describe('沒有管理權的人看不出差異', () => {
  for (const method of ['DELETE', 'PATCH'] as const) {
    const body = method === 'PATCH' ? { role: 'viewer' } : undefined;
    describe(method, () => {
      for (const who of ['tok-stranger', 'tok-member', 'tok-other-owner']) {
        it(`${who}：不存在的 id、owner 列、一般成員列的回應完全相同（狀態碼與內容）`, async () => {
          const ghost = await snapshot(await call(method, 999999, who, body));
          const asOwnerRow = await snapshot(await call(method, ownerRow, who, body));
          const asMemberRow = await snapshot(await call(method, viewerRow, who, body));
          expect(asOwnerRow).toEqual(ghost);
          expect(asMemberRow).toEqual(ghost);
          expect(ghost.status).toBe(404);
        });
      }
      it('被拒絕時資料完全不變', async () => {
        const before = rows();
        for (const id of [ownerRow, memberRow, viewerRow, 999999]) await call(method, id, 'tok-stranger', body);
        expect(rows()).toEqual(before);
      });
    });
  }
});

describe('行程 owner 的行為不變', () => {
  it('DELETE：可移除成員；owner 列 → 403 PERM_DENIED（不可移除擁有者）；不存在 → 404', async () => {
    expect((await call('DELETE', memberRow, 'tok-owner')).status).toBe(200);
    expect(rows()).not.toContainEqual({ id: memberRow, role: 'member' });
    const owner = await call('DELETE', ownerRow, 'tok-owner');
    expect(owner.status).toBe(403);
    expect(((await owner.json()) as { error: { code: string } }).error.code).toBe('PERM_DENIED');
    expect((await call('DELETE', 999999, 'tok-owner')).status).toBe(404);
  });
  it('PATCH：可把 viewer 改成 member；owner 列不可改（403）；相同角色 → unchanged；不存在 → 404', async () => {
    expect((await call('PATCH', viewerRow, 'tok-owner', { role: 'member' })).status).toBe(200);
    expect(d1.raw.prepare('SELECT role FROM trip_permissions WHERE id = ?').get(viewerRow)).toEqual({ role: 'member' });
    expect((await call('PATCH', ownerRow, 'tok-owner', { role: 'member' })).status).toBe(403);
    expect(await (await call('PATCH', viewerRow, 'tok-owner', { role: 'member' })).json()).toMatchObject({ unchanged: true });
    expect((await call('PATCH', 999999, 'tok-owner', { role: 'member' })).status).toBe(404);
  });
  it('PATCH 的 body 驗證仍在最前面：無效 role → 400（與是否有權限無關，維持原行為）', async () => {
    expect((await call('PATCH', viewerRow, 'tok-owner', { role: 'owner' })).status).toBe(400);
  });
});
