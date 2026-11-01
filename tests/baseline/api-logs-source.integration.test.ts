/**
 * Integration test — migration 0024: api_logs.source column
 *
 * 驗證 schema 有 source 欄位、能寫入各種 source 值、NULL source（legacy）也允許。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';

let db: D1Database;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(disposeMiniflare);

describe('api_logs.source column (migration 0024)', () => {
  it('schema: source column exists', async () => {
    const rows = await db.prepare('PRAGMA table_info(api_logs)').all();
    const cols = (rows.results as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain('source');
  });

  it('可寫入 source=scheduler', async () => {
    await db
      .prepare(
        'INSERT INTO api_logs (method, path, status, duration, source) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('GET', '/api/test-scheduler', 401, 10, 'scheduler')
      .run();
    const row = await db
      .prepare(
        "SELECT source FROM api_logs WHERE path = '/api/test-scheduler' ORDER BY id DESC LIMIT 1",
      )
      .first<{ source: string }>();
    expect(row?.source).toBe('scheduler');
  });

  it('可寫入 source=user_jwt', async () => {
    await db
      .prepare(
        'INSERT INTO api_logs (method, path, status, duration, source) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('PATCH', '/api/test-user', 403, 12, 'user_jwt')
      .run();
    const row = await db
      .prepare(
        "SELECT source FROM api_logs WHERE path = '/api/test-user' ORDER BY id DESC LIMIT 1",
      )
      .first<{ source: string }>();
    expect(row?.source).toBe('user_jwt');
  });

  it('legacy NULL source 允許（不帶 source 欄位 insert）', async () => {
    await db
      .prepare('INSERT INTO api_logs (method, path, status, duration) VALUES (?, ?, ?, ?)')
      .bind('GET', '/api/test-legacy', 500, 5)
      .run();
    const row = await db
      .prepare(
        "SELECT source FROM api_logs WHERE path = '/api/test-legacy' ORDER BY id DESC LIMIT 1",
      )
      .first<{ source: string | null }>();
    expect(row?.source).toBeNull();
  });

  it('GROUP BY source 能正確聚合（daily-check query pattern）', async () => {
    const rows = await db
      .prepare(
        "SELECT COALESCE(source, 'legacy') as source, COUNT(*) as count " +
          "FROM api_logs " +
          "WHERE path LIKE '/api/test-%' " +
          'GROUP BY source',
      )
      .all<{ source: string; count: number }>();
    const bySource: Record<string, number> = {};
    for (const r of rows.results as Array<{ source: string; count: number }>) {
      bySource[r.source] = r.count;
    }
    expect(bySource.scheduler).toBeGreaterThanOrEqual(1);
    expect(bySource.user_jwt).toBeGreaterThanOrEqual(1);
    expect(bySource.legacy).toBeGreaterThanOrEqual(1);
  });
});
