// @vitest-environment node
/**
 * 敏感操作要求重新驗證證明（spec trip-planner#1677、ADR-0016，票 api#82）。
 *
 * 五個操作、六條入口（撤銷分享有 DELETE 與 PATCH action=revoke 兩條）：
 *   變更密碼、刪除行程、撤銷分享、撤銷 passkey、刪除帳號。
 * 以 STEP_UP_ENFORCE=1 強制；未設時行為與原本完全相同（不檢查證明）。
 * 只擋「使用者本人的互動式登入」：服務 token、trip-scoped 受限 token（agent 用）不受影響。
 *
 * 走 HTTP 邊界：真實 bearer → middleware → handler。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor, type TestSession } from './account-session-helper';
import { hashPassword } from '../../src/lib/password';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { issueStepUpProof, STEP_UP_PROOF_HEADER } from '../../src/lib/step-up';
import type { AccountUser } from '../../src/lib/account-user';

const PREFIX = 'enf';
const PASSWORD = 'correct-horse-battery';
const SECRET = 'test-secret-32-chars-long-enough';

let db: D1Database;
let on: Api; // STEP_UP_ENFORCE=1
let off: Api; // 未設
let seq = 0;
const userIds: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  on = createApi({ env: mockEnv(db, { STEP_UP_ENFORCE: '1', SESSION_SECRET: SECRET }) });
  off = createApi({ env: mockEnv(db, { SESSION_SECRET: SECRET }) });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, messageId: 'm', elapsed: 1 }), { status: 200 })));
}, 30_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const id of userIds) {
    await db.prepare('DELETE FROM trip_shares WHERE trip_id LIKE ?').bind(`${id}-%`).run();
    await db.prepare('DELETE FROM trip_permissions WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM trips WHERE owner_user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM oauth_models WHERE json_extract(payload, \'$.user_id\') = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${id}%`).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

type User = TestSession & { email: string };
const SCOPES = ['trips:read', 'trips:write'];

async function seed(): Promise<User> {
  const id = `${PREFIX}-u${++seq}`;
  const email = `${id}@example.com`;
  userIds.push(id);
  const s = await sessionFor(db, email, id, { scopes: SCOPES });
  await db.prepare(`INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')`)
    .bind(id, email, await hashPassword(PASSWORD)).run();
  return { ...s, email };
}

async function seedTrip(u: User): Promise<string> {
  const tripId = `${u.userId}-trip`;
  await db.prepare('INSERT OR IGNORE INTO trips (id, name, owner_user_id, published) VALUES (?, ?, ?, 1)').bind(tripId, '行程', u.userId).run();
  await db.prepare(`INSERT OR IGNORE INTO trip_permissions (trip_id, user_id, role) VALUES (?, ?, 'owner')`).bind(tripId, u.userId).run();
  return tripId;
}
async function seedShare(tripId: string): Promise<number> {
  const r = await db.prepare('INSERT INTO trip_shares (trip_id, token_hash) VALUES (?, ?)').bind(tripId, `h-${crypto.randomUUID()}`).run();
  return r.meta.last_row_id as number;
}

const first = <T>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();
const pwHash = async (id: string) => (await first<{ password_hash: string }>(`SELECT password_hash FROM auth_identities WHERE user_id = ? AND provider = 'local'`, id))?.password_hash;

interface Op {
  name: string;
  /** 備妥資料，回請求與「操作是否已生效」的判斷。 */
  prep(u: User): Promise<{ method: string; path: string; json?: unknown; done: () => Promise<boolean> }>;
}

const OPS: Op[] = [
  {
    name: '變更密碼 POST /api/account/password',
    async prep(u) {
      const before = await pwHash(u.userId);
      return {
        method: 'POST', path: '/api/account/password', json: { current_password: PASSWORD, new_password: 'another-horse-battery' },
        done: async () => (await pwHash(u.userId)) !== before,
      };
    },
  },
  {
    name: '刪除行程 DELETE /api/trips/:id',
    async prep(u) {
      const tripId = await seedTrip(u);
      return { method: 'DELETE', path: `/api/trips/${tripId}`, done: async () => !(await first('SELECT 1 FROM trips WHERE id = ?', tripId)) };
    },
  },
  {
    name: '撤銷分享 DELETE /api/trips/:id/shares/:shareId',
    async prep(u) {
      const tripId = await seedTrip(u);
      const shareId = await seedShare(tripId);
      return { method: 'DELETE', path: `/api/trips/${tripId}/shares/${shareId}`, done: async () => !(await first('SELECT 1 FROM trip_shares WHERE id = ?', shareId)) };
    },
  },
  {
    name: '撤銷分享 PATCH /api/trips/:id/shares/:shareId action=revoke',
    async prep(u) {
      const tripId = await seedTrip(u);
      const shareId = await seedShare(tripId);
      return {
        method: 'PATCH', path: `/api/trips/${tripId}/shares/${shareId}`, json: { action: 'revoke' },
        done: async () => !!(await first<{ revoked_at: string | null }>('SELECT revoked_at FROM trip_shares WHERE id = ?', shareId))?.revoked_at,
      };
    },
  },
  {
    name: '撤銷 passkey DELETE /api/account/passkeys/:id',
    async prep(u) {
      const id = `cred-${crypto.randomUUID()}`;
      await db.prepare(`INSERT INTO passkey_credentials (id, user_id, public_key, alg, sign_count, name, transports, backup_eligible) VALUES (?, ?, 'PK', -7, 0, 'iPhone', '[]', 1)`)
        .bind(id, u.userId).run();
      return { method: 'DELETE', path: `/api/account/passkeys/${id}`, done: async () => !(await first('SELECT 1 FROM passkey_credentials WHERE id = ?', id)) };
    },
  },
  {
    name: '刪除帳號 DELETE /api/account',
    async prep(u) {
      return { method: 'DELETE', path: '/api/account', json: { password: PASSWORD }, done: async () => !(await first('SELECT 1 FROM users WHERE id = ?', u.userId)) };
    },
  },
];

const asUser = (u: { userId: string; grantId: string; email: string }): AccountUser =>
  ({ uid: u.userId, email: u.email, auth: { email: u.email, userId: u.userId, isServiceToken: false, grantId: u.grantId } });
const proofFor = (u: { userId: string; grantId: string; email: string }) => issueStepUpProof(db, asUser(u), 'password');
const code = async (res: Response) => ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
const call = (api: Api, who: { bearer: string }, r: { method: string; path: string; json?: unknown }, proof?: string) =>
  api.request(r.method, r.path, { bearer: who.bearer, json: r.json, headers: proof ? { [STEP_UP_PROOF_HEADER]: proof } : undefined });

describe.each(OPS)('$name', (op) => {
  it('強制開啟、沒帶證明 → 403 REAUTH_REQUIRED，資料不動', async () => {
    const u = await seed();
    const r = await op.prep(u);
    const res = await call(on, u, r);
    expect([res.status, await code(res)]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(await r.done()).toBe(false);
  });

  it('強制開啟、帶有效證明 → 200 並生效', async () => {
    const u = await seed();
    const r = await op.prep(u);
    const res = await call(on, u, r, await proofFor(u));
    expect(res.status).toBe(200);
    expect(await r.done()).toBe(true);
  });

  it('強制開啟、證明過期 → 403 REAUTH_REQUIRED，資料不動', async () => {
    const u = await seed();
    const r = await op.prep(u);
    const proof = await proofFor(u);
    await db.prepare('UPDATE oauth_models SET expires_at = ? WHERE name = ? AND id = ?').bind(Date.now() - 1000, 'StepUpProof', proof).run();
    const res = await call(on, u, r, proof);
    expect([res.status, await code(res)]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(await r.done()).toBe(false);
  });

  it('強制開啟、別人的證明 → 403 REAUTH_REQUIRED', async () => {
    const u = await seed();
    const stranger = await seed();
    const r = await op.prep(u);
    const res = await call(on, u, r, await proofFor(stranger));
    expect([res.status, await code(res)]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(await r.done()).toBe(false);
  });

  it('強制開啟、同一人另一個登入（不同 session）的證明 → 403 REAUTH_REQUIRED', async () => {
    const u = await seed();
    const r = await op.prep(u);
    const other = await sessionFor(db, u.email, u.userId, { scopes: SCOPES });
    const res = await call(on, u, r, await proofFor({ userId: u.userId, email: u.email, grantId: other.grantId }));
    expect([res.status, await code(res)]).toEqual([403, 'REAUTH_REQUIRED']);
    expect(await r.done()).toBe(false);
  });

  it('強制關閉（未設）、沒帶證明 → 照舊通過', async () => {
    const u = await seed();
    const r = await op.prep(u);
    const res = await call(off, u, r);
    expect(res.status).toBe(200);
    expect(await r.done()).toBe(true);
  });

  it('STEP_UP_ENFORCE 不是 "1"（"0"、"true"、空字串）→ 視為關閉', async () => {
    for (const v of ['0', 'true', '']) {
      const api = createApi({ env: mockEnv(db, { STEP_UP_ENFORCE: v, SESSION_SECRET: SECRET }) });
      const u = await seed();
      const r = await op.prep(u);
      expect((await call(api, u, r)).status, `STEP_UP_ENFORCE=${JSON.stringify(v)}`).toBe(200);
    }
  });
});

describe('有效證明在效期內可連續使用', () => {
  it('同一張證明連做撤銷分享、刪除行程都通過', async () => {
    const u = await seed();
    const proof = await proofFor(u);
    const a = await OPS[2]!.prep(u);
    expect((await call(on, u, a, proof)).status).toBe(200);
    const b = await OPS[1]!.prep(u);
    expect((await call(on, u, b, proof)).status).toBe(200);
  });
});

describe('只擋使用者本人的互動式登入：受限 token／服務 token 不受影響（強制開啟下）', () => {
  it('trip-scoped 受限 token 撤銷自己那個行程的分享（DELETE 與 PATCH revoke）→ 不要求證明', async () => {
    const owner = await seed();
    const tripId = await seedTrip(owner);
    const restricted = await sessionFor(db, owner.email, owner.userId, { restrictTrip: tripId });
    const s1 = await seedShare(tripId);
    const s2 = await seedShare(tripId);
    const patch = await on.request('PATCH', `/api/trips/${tripId}/shares/${s1}`, { bearer: restricted.bearer, json: { action: 'revoke' } });
    expect(patch.status).toBe(200);
    const del = await on.request('DELETE', `/api/trips/${tripId}/shares/${s2}`, { bearer: restricted.bearer });
    expect(del.status).toBe(200);
  });

  it('受限 token 刪行程仍是原本的 PERM_DENIED（不是 REAUTH_REQUIRED）', async () => {
    const owner = await seed();
    const tripId = await seedTrip(owner);
    const restricted = await sessionFor(db, owner.email, owner.userId, { restrictTrip: tripId });
    const res = await on.request('DELETE', `/api/trips/${tripId}`, { bearer: restricted.bearer });
    expect([res.status, await code(res)]).toEqual([403, 'PERM_DENIED']);
  });

  it('服務 token（無 user_id）打五個操作 → 結果與關閉時相同，且都不是 REAUTH_REQUIRED', async () => {
    const svc = `svc-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(svc, { jti: svc, client_id: 'svc-client', user_id: null, scopes: ['trips:write'] }, 300);
    const u = await seed();
    for (const op of OPS) {
      const r = await op.prep(u);
      const a = await call(on, { bearer: svc }, r);
      const b = await call(off, { bearer: svc }, r);
      expect([a.status, await code(a)], op.name).toEqual([b.status, await code(b)]);
      expect(await code(a), op.name).not.toBe('REAUTH_REQUIRED');
    }
  });
});

describe('OpenAPI 文件', () => {
  it('六條入口的 403 都寫了 REAUTH_REQUIRED', async () => {
    const spec = (await (await off.fetch(new Request('https://test.com/openapi.json'))).json()) as { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>> };
    const entries: Array<[string, string]> = [
      ['/api/account/password', 'post'], ['/api/trips/{id}', 'delete'], ['/api/trips/{id}/shares/{shareId}', 'delete'],
      ['/api/trips/{id}/shares/{shareId}', 'patch'], ['/api/account/passkeys/{id}', 'delete'], ['/api/account', 'delete'],
    ];
    for (const [path, method] of entries) {
      expect(spec.paths[path]?.[method]?.responses['403']?.description, `${method} ${path}`).toContain('REAUTH_REQUIRED');
    }
  });
});
