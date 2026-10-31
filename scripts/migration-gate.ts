/// <reference types="node" />
/**
 * migration 閘門：舊入口存在期間，api 的 migration 只加不刪（拆分 T15）。
 *
 *   node scripts/migration-gate.ts [--dir=migrations] [--baseline=<dir>/baseline.json]
 *   node scripts/migration-gate.ts --write-baseline    # 重新產生基準線（人工審查後才提交）
 *
 * 結束碼：0 通過；1 有違規；2 閘門自己跑不起來（目錄或基準線讀不到）—— 不是「安全」，是「沒檢查」。
 * 這是文字比對，不是 SQL parser：擋的是「新 migration 出現任何 DROP／RENAME」，不證明其餘敘述安全。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Baseline {
  /** 基準線內最大的 migration 編號；比它大的才算「新」。 */
  maxNumber: number;
  /** 基準線內每個 migration 的 sha256，改動或刪除都會被抓到。 */
  files: Record<string, string>;
}

export type Rule =
  | 'DROP'
  | 'RENAME'
  | 'WRITABLE_SCHEMA'
  | 'BASELINE_MODIFIED'
  | 'BASELINE_MISSING'
  | 'NUMBERING'
  | 'FILENAME'
  | 'NO_MIGRATIONS';

export interface Violation {
  file: string;
  rule: Rule;
  detail: string;
}

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 剝掉註解、單引號字串、雙引號／反引號／中括號識別字，只留下 SQL 的結構字。 */
export function stripSql(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      // 引號內以兩個引號表示跳脫
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
    } else if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function destructive(sql: string): { rule: Rule; detail: string }[] {
  const s = stripSql(sql).toUpperCase();
  const found: { rule: Rule; detail: string }[] = [];
  if (/\bDROP\b/.test(s)) found.push({ rule: 'DROP', detail: '新 migration 不得有 DROP（TABLE／INDEX／VIEW／TRIGGER／COLUMN）' });
  if (/\bRENAME\b/.test(s)) found.push({ rule: 'RENAME', detail: '新 migration 不得有 RENAME（表或欄位）' });
  if (/\bPRAGMA\s+WRITABLE_SCHEMA\b/.test(s)) found.push({ rule: 'WRITABLE_SCHEMA', detail: '不得改寫 schema 表' });
  return found;
}

export function buildBaseline(dir: string): Baseline {
  const files: Record<string, string> = {};
  let maxNumber = 0;
  for (const name of fs.readdirSync(dir).sort()) {
    const m = NAME.exec(name);
    if (!m) continue;
    files[name] = sha256(fs.readFileSync(path.join(dir, name), 'utf8'));
    maxNumber = Math.max(maxNumber, Number(m[1]));
  }
  return { maxNumber, files };
}

export function checkMigrations(opts: { dir: string; baseline: Baseline }): { ok: boolean; violations: Violation[] } {
  const { dir, baseline } = opts;
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')); // 目錄不存在會在這裡拋錯（fail closed）
  const violations: Violation[] = [];
  const add = (file: string, rule: Rule, detail: string) => violations.push({ file, rule, detail });

  if (names.length === 0) add('(migrations)', 'NO_MIGRATIONS', '目錄裡沒有任何 migration');

  for (const [name, hash] of Object.entries(baseline.files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) add(name, 'BASELINE_MISSING', '基準線內的 migration 不得刪除');
    else if (sha256(fs.readFileSync(file, 'utf8')) !== hash) add(name, 'BASELINE_MODIFIED', '基準線內的 migration 不得改動');
  }

  const fresh: { name: string; num: number }[] = [];
  for (const name of names.sort()) {
    const m = NAME.exec(name);
    if (!m) { add(name, 'FILENAME', '檔名必須是 NNNN_name.sql（小寫、底線）'); continue; }
    const num = Number(m[1]);
    if (num <= baseline.maxNumber) {
      if (!(name in baseline.files)) add(name, 'NUMBERING', `編號 ${m[1]} 落在基準線內，但不是基準線的檔案`);
      continue;
    }
    fresh.push({ name, num });
    for (const v of destructive(fs.readFileSync(path.join(dir, name), 'utf8'))) add(name, v.rule, v.detail);
  }

  // 新 migration 的編號必須從 maxNumber+1 起連續、不重複
  fresh.forEach(({ name, num }, i) => {
    const expected = baseline.maxNumber + 1 + i;
    if (num !== expected) add(name, 'NUMBERING', `編號應為 ${String(expected).padStart(4, '0')}，實為 ${String(num).padStart(4, '0')}（跳號或重複）`);
  });

  return { ok: violations.length === 0, violations };
}

function main(argv: string[]): number {
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const dir = arg('dir') ?? 'migrations';
  const baselinePath = arg('baseline') ?? path.join(dir, 'baseline.json');
  try {
    if (argv.includes('--write-baseline')) {
      fs.writeFileSync(baselinePath, `${JSON.stringify(buildBaseline(dir), null, 2)}\n`);
      console.log(`已寫入 ${baselinePath}`);
      return 0;
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Baseline;
    if (typeof baseline.maxNumber !== 'number' || typeof baseline.files !== 'object' || baseline.files === null) {
      throw new Error('基準線檔格式不對');
    }
    const result = checkMigrations({ dir, baseline });
    if (result.ok) {
      const total = fs.readdirSync(dir).filter((n) => NAME.test(n)).length;
      console.log(`migration gate OK（${total} 個 migration，${total - Object.keys(baseline.files).length} 個新的）`);
      return 0;
    }
    for (const v of result.violations) console.error(`✗ ${v.file}  [${v.rule}]  ${v.detail}`);
    return 1;
  } catch (err) {
    console.error(`migration gate 跑不起來（不是通過）：${(err as Error).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
