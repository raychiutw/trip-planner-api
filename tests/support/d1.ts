/**
 * 測試用 D1：node:sqlite（與 D1 同為 SQLite）套用 migrations/ 全部檔案（按編號）。
 * 支援 prepare().bind().first()/all()/run() 與 batch()。
 * 取捨：同步執行，所以「併發」等同序列；真正的 D1 併發行為靠整合環境驗。
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Row = Record<string, unknown>;

export function createD1(opts: { through?: number } = {}): { db: D1Database; raw: DatabaseSync; close: () => void; applyMigrationsAfter: (n: number) => void } {
  const raw = new DatabaseSync(':memory:');
  const dir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort();
  const num = (f: string) => Number(f.slice(0, 4));
  for (const f of files.filter((x) => opts.through === undefined || num(x) <= opts.through)) raw.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  /** 接著套用編號大於 n 的 migration（測試「套用當下資料庫裡已有資料」的情境）。 */
  const applyMigrationsAfter = (n: number) => { for (const f of files.filter((x) => num(x) > n)) raw.exec(fs.readFileSync(path.join(dir, f), 'utf8')); };
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const isRead = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    const exec = () => {
      if (isRead) {
        const rows = raw.prepare(sql).all(...(params as never[])) as Row[];
        return { results: rows, success: true, meta: { changes: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0, duration: 0 } };
      }
      const r = raw.prepare(sql).run(...(params as never[]));
      return { results: [] as Row[], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_read: 0, rows_written: Number(r.changes), duration: 0 } };
    };
    const stmt = {
      bind(...p: unknown[]) { params = p; return stmt; },
      async first<T = Row>(col?: string): Promise<T | null> {
        const row = raw.prepare(sql).get(...(params as never[])) as Row | undefined;
        if (!row) return null;
        return (col === undefined ? row : row[col]) as T;
      },
      async all<T = Row>() { return exec() as unknown as { results: T[] }; },
      async raw<T = unknown[]>() { return (raw.prepare(sql).all(...(params as never[])) as Row[]).map((r) => Object.values(r)) as T[]; },
      async run() { return exec(); },
      __exec: exec,
    };
    return stmt;
  };
  const batch = async (stmts: Array<{ __exec: () => unknown }>) => {
    raw.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.__exec());
      raw.exec('COMMIT');
      return out;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  };
  const execSql = async (sql: string) => { raw.exec(sql); return { count: 1, duration: 0 }; };
  return { db: { prepare, batch, exec: execSql } as unknown as D1Database, raw, close: () => raw.close(), applyMigrationsAfter };
}
