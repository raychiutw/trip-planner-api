/**
 * eraseUserAccount 是單一 D1 batch：末段失敗整批回滾，修復後可重試
 * （自舊入口 tests/unit/account-erasure.test.ts 的新增案例移植）。
 * 另外驗證 token／grant／challenge 都在同一批內被抹除（$.user_id 與 $.uid 兩種鍵）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { eraseUserAccount } from '../../src/lib/erasure';

describe('eraseUserAccount：atomic batch', () => {
  let db: D1Database;
  beforeAll(async () => { db = await createTestDb(); }, 60000);
  afterAll(disposeMiniflare);

  async function seedUser(id: string): Promise<void> {
    await db.prepare("INSERT INTO users (id, email, display_name, status) VALUES (?, ?, ?, 'active')").bind(id, `${id}@example.com`, id).run();
  }
  const present = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first()) !== null;

  it('末段刪除失敗會回滾整批資料（行程、oauth_models 都還在），修復後可重試', async () => {
    const uid = 'erase-retry-u';
    await seedUser(uid);
    await db.prepare('INSERT INTO trips (id, name, owner_user_id, published) VALUES (?, ?, ?, 1)').bind('erase-retry-trip', '仍在', uid).run();
    await db.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', 'erase-retry-tok', ?, ?)")
      .bind(JSON.stringify({ user_id: uid }), Date.now() + 60000).run();
    await db.prepare(`CREATE TRIGGER erase_retry_fail BEFORE DELETE ON users
      WHEN OLD.id = '${uid}' BEGIN SELECT RAISE(ABORT, 'simulated erasure failure'); END`).run();
    try {
      await expect(eraseUserAccount(db, uid)).rejects.toThrow();
      expect(await present('SELECT 1 FROM users WHERE id = ?', uid)).toBe(true);
      expect(await present('SELECT 1 FROM trips WHERE id = ?', 'erase-retry-trip')).toBe(true);
      expect(await present("SELECT 1 FROM oauth_models WHERE id = 'erase-retry-tok'")).toBe(true);
    } finally {
      await db.prepare('DROP TRIGGER erase_retry_fail').run();
    }
    const summary = await eraseUserAccount(db, uid);
    expect(summary.tripsDeleted).toBe(1);
    expect(await present('SELECT 1 FROM users WHERE id = ?', uid)).toBe(false);
    expect(await present("SELECT 1 FROM oauth_models WHERE id = 'erase-retry-tok'")).toBe(false);
  });

  it('oauth_models：$.user_id（token、consent）與 $.uid（challenge、session）都清掉，別人的不動', async () => {
    await seedUser('erase-scope-a'); await seedUser('erase-scope-b');
    const put = (name: string, id: string, payload: object) =>
      db.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)').bind(name, id, JSON.stringify(payload), Date.now() + 60000).run();
    await put('AccessToken', 'scope-a-at', { user_id: 'erase-scope-a', grantId: 'g' });
    await put('Consent', 'scope-a-consent', { user_id: 'erase-scope-a' });
    await put('AccountDeleteChallenge', 'scope-a-ch', { uid: 'erase-scope-a', status: 'verified' });
    await put('AccessToken', 'scope-b-at', { user_id: 'erase-scope-b', grantId: 'g2' });
    await put('AccountDeleteChallenge', 'scope-b-ch', { uid: 'erase-scope-b', status: 'verified' });
    const summary = await eraseUserAccount(db, 'erase-scope-a');
    expect(summary.tablesCleared['oauth_models']).toBe(3);
    for (const id of ['scope-a-at', 'scope-a-consent', 'scope-a-ch']) expect(await present('SELECT 1 FROM oauth_models WHERE id = ?', id), id).toBe(false);
    for (const id of ['scope-b-at', 'scope-b-ch']) expect(await present('SELECT 1 FROM oauth_models WHERE id = ?', id), id).toBe(true);
  });

  it('刪不存在的 user 不炸（冪等）', async () => {
    await expect(eraseUserAccount(db, 'no-such-user')).resolves.toBeTruthy();
  });
});
