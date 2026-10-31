/// <reference types="node" />
/**
 * migration 閘門（拆分 T15）：舊入口存在期間，api 的 migration 只加不刪。
 *
 * 規則：編號大於基準線的新 migration，不得出現任何 DROP 或 RENAME（含 ALTER TABLE ... RENAME／DROP COLUMN、
 * PRAGMA writable_schema）；基準線內的舊 migration 內容不得被改動或刪除；編號必須連續、檔名格式固定。
 * 閘門 fail closed：目錄讀不到、沒有檔案、基準線檔壞掉都是失敗，不是「沒問題」。
 * 比對前先剝掉註解與字串字面值，所以註解或資料裡出現 "DROP TABLE" 不會誤報。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMigrations, type Baseline } from '../scripts/migration-gate';

const root = path.resolve(__dirname, '..');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let dir: string;
let baseline: Baseline;

/** 建一個迷你目錄：0001、0002 是基準線，之後的是「新」migration。 */
function setup(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-'));
  const legacy: Record<string, string> = {
    '0001_init.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);\n',
    // 基準線內允許歷史上的 DROP／RENAME
    '0002_swap.sql': 'CREATE TABLE b2 (id INTEGER);\nDROP TABLE b;\nALTER TABLE b2 RENAME TO b;\n',
  };
  baseline = { maxNumber: 2, files: {} };
  for (const [name, sql] of Object.entries(legacy)) {
    fs.writeFileSync(path.join(dir, name), sql);
    baseline.files[name] = sha(sql);
  }
}

const add = (name: string, sql: string) => fs.writeFileSync(path.join(dir, name), sql);
const rules = (r: ReturnType<typeof checkMigrations>) => r.violations.map((v) => v.rule);

beforeEach(setup);
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('新 migration 只加不刪', () => {
  it('基準線本身（含歷史 DROP／RENAME）通過', () => {
    expect(checkMigrations({ dir, baseline })).toEqual({ ok: true, violations: [] });
  });

  it('加法 migration（CREATE TABLE／ADD COLUMN／CREATE INDEX／INSERT／UPDATE）通過', () => {
    add('0003_add.sql', [
      'CREATE TABLE c (id INTEGER PRIMARY KEY, v TEXT);',
      'ALTER TABLE a ADD COLUMN note TEXT;',
      'CREATE INDEX idx_c_v ON c (v);',
      "INSERT INTO c (v) VALUES ('x');",
      "UPDATE c SET v = 'y' WHERE id = 1;",
    ].join('\n'));
    expect(checkMigrations({ dir, baseline }).ok).toBe(true);
  });

  it('DROP TABLE → 失敗', () => {
    add('0003_bad.sql', 'DROP TABLE a;\n');
    const r = checkMigrations({ dir, baseline });
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain('DROP');
    expect(r.violations[0]!.file).toBe('0003_bad.sql');
  });

  it('DROP INDEX／DROP VIEW／DROP TRIGGER → 失敗', () => {
    for (const [i, stmt] of ['DROP INDEX IF EXISTS x;', 'DROP VIEW v;', 'DROP TRIGGER t;'].entries()) {
      add(`000${3 + i}_bad.sql`, `${stmt}\n`);
    }
    const r = checkMigrations({ dir, baseline });
    expect(r.violations.filter((v) => v.rule === 'DROP')).toHaveLength(3);
  });

  it('ALTER TABLE ... DROP COLUMN → 失敗', () => {
    add('0003_bad.sql', 'ALTER TABLE a DROP COLUMN note;\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('DROP');
  });

  it('ALTER TABLE ... RENAME TO → 失敗', () => {
    add('0003_bad.sql', 'ALTER TABLE a RENAME TO a_old;\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('RENAME');
  });

  it('ALTER TABLE ... RENAME COLUMN → 失敗', () => {
    add('0003_bad.sql', 'ALTER TABLE a RENAME COLUMN id TO pk;\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('RENAME');
  });

  it('PRAGMA writable_schema → 失敗', () => {
    add('0003_bad.sql', 'PRAGMA writable_schema = 1;\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('WRITABLE_SCHEMA');
  });

  it('大小寫與換行不能繞過（drop\\n  table、Alter … rename）', () => {
    add('0003_bad.sql', 'drop\n  table a;\n');
    add('0004_bad.sql', 'Alter Table a\n   Rename\n  To z;\n');
    const r = checkMigrations({ dir, baseline });
    expect(rules(r)).toEqual(expect.arrayContaining(['DROP', 'RENAME']));
  });

  it('註解與字串字面值裡的 DROP／RENAME 不誤報', () => {
    add('0003_ok.sql', [
      '-- 之後不要 DROP TABLE a，也不要 RENAME 它',
      '/* DROP TABLE a; ALTER TABLE a RENAME TO b; */',
      "INSERT INTO a (id) VALUES (1); -- DROP TABLE",
      "CREATE TABLE notes (t TEXT DEFAULT 'DROP TABLE x; RENAME');",
      'CREATE TABLE q ("drop" TEXT);',
    ].join('\n'));
    expect(checkMigrations({ dir, baseline }).ok).toBe(true);
  });

  it('字串裡有跳脫的單引號（\'\'）時，後面的真 DROP 仍抓得到', () => {
    add('0003_bad.sql', "INSERT INTO a (id) VALUES ('it''s'); DROP TABLE a;\n");
    expect(rules(checkMigrations({ dir, baseline }))).toContain('DROP');
  });
});

describe('基準線完整性', () => {
  it('改動基準線內的舊 migration → 失敗（不能事後把歷史改乾淨）', () => {
    add('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('BASELINE_MODIFIED');
  });

  it('刪除基準線內的舊 migration → 失敗', () => {
    fs.rmSync(path.join(dir, '0001_init.sql'));
    expect(rules(checkMigrations({ dir, baseline }))).toContain('BASELINE_MISSING');
  });
});

describe('編號與檔名', () => {
  it('新 migration 編號跳號 → 失敗', () => {
    add('0004_gap.sql', 'CREATE TABLE g (id INTEGER);\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('NUMBERING');
  });

  it('新 migration 編號重複 → 失敗', () => {
    add('0003_a.sql', 'CREATE TABLE a3 (id INTEGER);\n');
    add('0003_b.sql', 'CREATE TABLE b3 (id INTEGER);\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('NUMBERING');
  });

  it('檔名不符 NNNN_name.sql → 失敗', () => {
    add('0003 Add Stuff.sql', 'CREATE TABLE s (id INTEGER);\n');
    expect(rules(checkMigrations({ dir, baseline }))).toContain('FILENAME');
  });
});

describe('fail closed', () => {
  it('目錄不存在 → 拋錯，不是通過', () => {
    expect(() => checkMigrations({ dir: path.join(dir, 'nope'), baseline })).toThrow();
  });

  it('目錄裡一個 migration 都沒有 → 失敗', () => {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    const r = checkMigrations({ dir, baseline: { maxNumber: 0, files: {} } });
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain('NO_MIGRATIONS');
  });
});

describe('真實的 migrations/ 與基準線', () => {
  const run = (...args: string[]) =>
    spawnSync('node', ['scripts/migration-gate.ts', ...args], { cwd: root, encoding: 'utf-8' });

  it('repo 現況通過閘門（exit 0）', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK/);
  });

  it('CLI：新 migration 帶 DROP → exit 1，輸出指出檔案與規則', () => {
    add('0003_bad.sql', 'DROP TABLE a;\n');
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline));
    const r = run(`--dir=${dir}`, `--baseline=${path.join(dir, 'baseline.json')}`);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/0003_bad\.sql.*DROP/);
  });

  it('CLI：目錄不存在 → exit 2（沒檢查，不是安全）', () => {
    const r = run(`--dir=${path.join(dir, 'nope')}`);
    expect(r.status).toBe(2);
  });

  it('CLI：基準線檔壞掉 → exit 2', () => {
    fs.writeFileSync(path.join(dir, 'baseline.json'), '{not json');
    const r = run(`--dir=${dir}`, `--baseline=${path.join(dir, 'baseline.json')}`);
    expect(r.status).toBe(2);
  });
});
