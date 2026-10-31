/**
 * rate-limit 測試用的 D1 替身：以 node:sqlite（Node 內建、與 D1 同為 SQLite）實作測試用到的
 * prepare().bind().first()/all()/run()，並套用 0035_rate_limit_buckets.sql。
 *
 * 為何不用 Miniflare：它只是 wrangler 的傳遞依賴（本 repo 解析到 v5 beta、設定格式與舊 repo 不同），
 * 不應在測試裡依賴；「不新增依賴」是本票規則。
 * 取捨：node:sqlite 是同步的，所以 rate-limit-atomic 的「併發」在這裡等同序列執行；
 * RETURNING / ON CONFLICT 的 SQL 語意仍由真 SQLite 驗證，真正的 D1 併發行為需靠整合環境。
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

let sqlite: DatabaseSync | null = null;

type Row = Record<string, unknown>;

export async function createTestDb(): Promise<D1Database> {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(__dirname, '../../migrations/0035_rate_limit_buckets.sql'), 'utf8'));
  const db = sqlite;
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async first<T = Row>(): Promise<T | null> {
        return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        return { results: db.prepare(sql).all(...(params as never[])) as T[] };
      },
      async run() {
        const r = db.prepare(sql).run(...(params as never[]));
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

export async function disposeMiniflare(): Promise<void> {
  sqlite?.close();
  sqlite = null;
}
