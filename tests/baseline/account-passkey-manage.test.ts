/**
 * passkey 管理（spec web#1677、票 api#80）：
 *   GET    /api/account/passkeys       列出自己的 passkey（不含公鑰與簽名計數）
 *   PATCH  /api/account/passkeys/:id   改名
 *   DELETE /api/account/passkeys/:id   撤銷（刪資料、寄通知信、寫稽核，不動其他 session）
 *
 * 走 HTTP 邊界。憑證列直接以 SQL 種入（註冊流程由 account-passkey-register.test.ts 覆蓋）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor, type TestSession } from './account-session-helper';
import { eraseUserAccount } from '../../src/lib/erasure';

const PREFIX = 'pkmgr';
const MAILER = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'test-bearer' };

let db: D1Database;
let api: Api;
let seq = 0;
const userIds: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, MAILER) });
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); });

afterAll(async () => {
  for (const id of userIds) {
    await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM oauth_models WHERE json_extract(payload, \'$.user_id\') = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

async function seed(): Promise<TestSession & { email: string }> {
  const id = `${PREFIX}-u${++seq}`;
  const email = `${id}@example.com`;
  userIds.push(id);
  return { ...(await sessionFor(db, email, id)), email };
}

async function addKey(userId: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = `cred-${crypto.randomUUID()}`;
  const r = { name: 'iPhone', transports: '["internal","hybrid"]', backup_eligible: 1, last_used_at: '2026-11-01 08:00:00', ...over };
  await db.prepare(`INSERT INTO passkey_credentials (id, user_id, public_key, alg, sign_count, name, transports, backup_eligible, last_used_at)
    VALUES (?, ?, 'SECRET-PUBKEY', -7, 42, ?, ?, ?, ?)`)
    .bind(id, userId, r.name, r.transports, r.backup_eligible, r.last_used_at).run();
  return id;
}

const mails = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/internal/mail/send'));
const stubMailer = (res: Response = new Response(JSON.stringify({ ok: true, messageId: 'm1', elapsed: 5 }), { status: 200 })) => {
  const fetchMock = vi.fn().mockResolvedValue(res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const list = (bearer?: string) => api.request('GET', '/api/account/passkeys', { bearer });
const rename = (bearer: string | undefined, id: string, json: unknown) => api.request('PATCH', `/api/account/passkeys/${id}`, { bearer, json });
const revoke = (bearer: string | undefined, id: string) => api.request('DELETE', `/api/account/passkeys/${id}`, { bearer });
const rows = async (userId: string) =>
  (await db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').bind(userId).all<Record<string, unknown>>()).results;
const nameOf = async (id: string) => (await db.prepare('SELECT name FROM passkey_credentials WHERE id = ?').bind(id).first<{ name: string }>())?.name;

describe('GET /api/account/passkeys', () => {
  it('401 未登入', async () => {
    expect((await list()).status).toBe(401);
  });

  it('只回自己的，欄位齊全且不含公鑰與簽名計數', async () => {
    const a = await seed();
    const b = await seed();
    const idA = await addKey(a.userId, { name: '我的 iPhone' });
    await addKey(b.userId, { name: '別人的' });
    const res = await list(a.bearer);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('SECRET-PUBKEY');
    expect(text).not.toMatch(/public_?key|sign_?count/i);
    const out = JSON.parse(text) as { passkeys: Record<string, unknown>[] };
    expect(out.passkeys).toHaveLength(1);
    expect(out.passkeys[0]).toEqual({
      id: idA, name: '我的 iPhone', transports: ['internal', 'hybrid'], backupEligible: true,
      createdAt: expect.any(String), lastUsedAt: '2026-11-01 08:00:00',
    });
  });

  it('沒有 transports、沒用過時回空陣列與 null；沒有任何 passkey 回空清單', async () => {
    const a = await seed();
    expect(((await (await list(a.bearer)).json()) as any).passkeys).toEqual([]);
    await addKey(a.userId, { transports: null, last_used_at: null, backup_eligible: 0 });
    const [p] = ((await (await list(a.bearer)).json()) as any).passkeys;
    expect(p).toMatchObject({ transports: [], lastUsedAt: null, backupEligible: false });
  });
});

describe('PATCH /api/account/passkeys/:id', () => {
  it('401 未登入', async () => {
    const a = await seed();
    const id = await addKey(a.userId);
    expect((await rename(undefined, id, { name: 'x' })).status).toBe(401);
    expect(await nameOf(id)).toBe('iPhone');
  });

  it('改名成功：回新名稱、DB 更新；前後空白去掉、超過 50 字截斷', async () => {
    const a = await seed();
    const id = await addKey(a.userId);
    const res = await rename(a.bearer, id, { name: '  工作用 MacBook  ' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).name).toBe('工作用 MacBook');
    expect(await nameOf(id)).toBe('工作用 MacBook');
    expect((await rename(a.bearer, id, { name: 'x'.repeat(80) })).status).toBe(200);
    expect(await nameOf(id)).toBe('x'.repeat(50));
  });

  it.each([[{}], [{ name: '' }], [{ name: '   ' }], [{ name: 123 }]])('名稱不合法 %j → 400，名稱不變', async (payload) => {
    const a = await seed();
    const id = await addKey(a.userId);
    const res = await rename(a.bearer, id, payload);
    expect(res.status).toBe(400);
    expect(await nameOf(id)).toBe('iPhone');
  });

  it('對他人的 id → 404 且資料不變；不存在的 id 同樣 404', async () => {
    const a = await seed();
    const b = await seed();
    const idB = await addKey(b.userId, { name: '乙的' });
    const res = await rename(a.bearer, idB, { name: '被改了' });
    expect(res.status).toBe(404);
    expect(await nameOf(idB)).toBe('乙的');
    const missing = await rename(a.bearer, 'no-such-cred', { name: 'x' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(await (await rename(a.bearer, idB, { name: 'x' })).text());
  });
});

describe('DELETE /api/account/passkeys/:id', () => {
  it('401 未登入，資料不變', async () => {
    const a = await seed();
    const id = await addKey(a.userId);
    expect((await revoke(undefined, id)).status).toBe(401);
    expect(await rows(a.userId)).toHaveLength(1);
  });

  it('撤銷成功：資料列消失、只刪指定那一筆、列表不再出現', async () => {
    const a = await seed();
    stubMailer();
    const id = await addKey(a.userId);
    const keep = await addKey(a.userId, { name: '留著' });
    const res = await revoke(a.bearer, id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
    expect((await rows(a.userId)).map((r) => r.id)).toEqual([keep]);
    expect(((await (await list(a.bearer)).json()) as any).passkeys.map((p: any) => p.id)).toEqual([keep]);
    expect((await revoke(a.bearer, id)).status).toBe(404); // 已撤銷再撤銷
  });

  it('對他人的 id → 404 且資料不變、不寄信；與不存在的 id 回應相同', async () => {
    const a = await seed();
    const b = await seed();
    const m = stubMailer();
    const idB = await addKey(b.userId);
    const res = await revoke(a.bearer, idB);
    expect(res.status).toBe(404);
    expect(await rows(b.userId)).toHaveLength(1);
    expect(mails(m)).toHaveLength(0);
    expect(await res.text()).toBe(await (await revoke(a.bearer, 'no-such-cred')).text());
  });

  it('撤銷不影響使用者的 session／token（access、refresh 與其他裝置的都還在）', async () => {
    const a = await seed();
    const other = await sessionFor(db, a.email, a.userId); // 另一個裝置
    stubMailer();
    const id = await addKey(a.userId);
    expect((await revoke(a.bearer, id)).status).toBe(200);
    expect((await list(a.bearer)).status).toBe(200);
    expect((await list(other.bearer)).status).toBe(200);
    const left = await db.prepare(`SELECT count(*) AS n FROM oauth_models WHERE json_extract(payload, '$.user_id') = ?`).bind(a.userId).first<{ n: number }>();
    expect(left!.n).toBe(4);
  });

  it('撤銷寄「passkey 已移除」通知信給本人，內含名稱', async () => {
    const a = await seed();
    const m = stubMailer();
    const id = await addKey(a.userId, { name: '舊手機' });
    await revoke(a.bearer, id);
    const sent = mails(m);
    expect(sent).toHaveLength(1);
    const payload = String(sent[0]![1]?.body);
    expect(payload).toContain(a.email);
    expect(payload).toContain('舊手機');
    expect(payload).toContain('移除');
  });

  it('寄信失敗不影響結果（仍 200、資料已刪）', async () => {
    const a = await seed();
    stubMailer(new Response('boom', { status: 500 }));
    const id = await addKey(a.userId);
    expect((await revoke(a.bearer, id)).status).toBe(200);
    expect(await rows(a.userId)).toHaveLength(0);
  });

  it('寫稽核事件 passkey_revoke success', async () => {
    const a = await seed();
    stubMailer();
    await revoke(a.bearer, await addKey(a.userId));
    const row = await db.prepare(`SELECT outcome FROM auth_audit_log WHERE user_id = ? AND event_type = 'passkey_revoke'`).bind(a.userId).first<{ outcome: string }>();
    expect(row?.outcome).toBe('success');
  });
});

describe('刪除帳號', () => {
  it('erasure 自己明確清除 passkey（不是靠 ON DELETE CASCADE 蓋過去），別人的不受影響', async () => {
    const a = await seed();
    const b = await seed();
    await addKey(a.userId);
    await addKey(a.userId);
    await addKey(b.userId);
    const summary = await eraseUserAccount(db, a.userId);
    expect(await rows(a.userId)).toHaveLength(0);
    expect(await rows(b.userId)).toHaveLength(1);
    // SQLite 的 changes() 不計 CASCADE 連動的列：回報有 2 筆代表是 erasure 清單裡的 DELETE 刪的。
    // 若有人把 passkey_credentials 從清單移除，CASCADE 仍會刪光資料，但這個數字會變 undefined。
    expect(summary.tablesCleared.passkey_credentials).toBe(2);
  });
});
