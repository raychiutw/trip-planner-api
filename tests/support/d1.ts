/**
 * 測試用 D1：node:sqlite（與 D1 同為 SQLite）套用 migrations/ 全部檔案（按編號）。
 * 支援 prepare().bind().first()/all()/run() 與 batch()。
 * 取捨：同步執行，所以「併發」等同序列；真正的 D1 併發行為靠整合環境驗。
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Row = Record<string, unknown>;

export function createD1(): { db: D1Database; raw: DatabaseSync; close: () => void } {
  const raw = new DatabaseSync(':memory:');
  const dir = path.join(__dirname, '../../migrations');
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    raw.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) { params = p; return stmt; },
      async first<T = Row>(): Promise<T | null> {
        return (raw.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        return { results: raw.prepare(sql).all(...(params as never[])) as T[] };
      },
      async run() {
        const r = raw.prepare(sql).run(...(params as never[]));
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  const batch = async (stmts: Array<{ run: () => Promise<unknown> }>) => {
    raw.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      raw.exec('COMMIT');
      return out;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  };
  return { db: { prepare, batch } as unknown as D1Database, raw, close: () => raw.close() };
}
