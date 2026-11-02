import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AgentContract {
  version: number;
  dailyCheckSql: Array<{ source: string; sql: string[]; skipped?: string }>;
  companionTools: Array<{ name: string; method: string; path: string }>;
}

export const contract: AgentContract = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/agent-contract.json'), 'utf8'),
);

/** 取得某個 daily-check 來源的第 n 條 SQL；來源或順序變了就直接拋錯（快照改了要同步改測試）。 */
export function sqlOf(source: string, index = 0): string {
  const entry = contract.dailyCheckSql.find((s) => s.source === source);
  if (!entry) throw new Error(`快照缺少 daily-check 來源 ${source}`);
  const sql = entry.sql[index];
  if (!sql) throw new Error(`快照的 ${source} 沒有第 ${index} 條 SQL`);
  return sql;
}
