/**
 * 帳號抹除對 oauth_models 的刪除不得整表掃描（自舊入口 tests/unit/erasure-oauth-models-plan.test.ts 移植）。
 * 用 EXPLAIN QUERY PLAN 看真正使用的那條 SQL（OAUTH_MODELS_ERASE_SQL）：每個條件都要走索引
 * （$.user_id 的索引由 migration 0098 提供）。沒有索引時 OR 會讓整條退化成整表掃描。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createD1 } from '../support/d1';
import { OAUTH_MODELS_ERASE_SQL } from '../../src/lib/erasure';

describe('抹除 oauth_models 的查詢計畫', () => {
  // 測試用 D1 包裝把非 SELECT 當寫入（回不了列），所以直接用底層的 node:sqlite 連線跑 EXPLAIN。
  let handle: ReturnType<typeof createD1>;
  beforeAll(() => { handle = createD1(); });
  afterAll(() => handle.close());

  const plan = async (sql: string) => {
    const rows = handle.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('u', 'u') as Array<{ detail: string }>;
    expect(rows.length, '查詢計畫不得是空的（否則下面的斷言是空轉）').toBeGreaterThan(0);
    return rows.map((r) => r.detail);
  };

  it('正式使用的刪除語句不含整表掃描（SCAN oauth_models）', async () => {
    const details = await plan(OAUTH_MODELS_ERASE_SQL);
    expect(details.filter((d) => /SCAN/i.test(d)), `查詢計畫：\n${details.join('\n')}`).toEqual([]);
  });

  it('兩個條件各自用到索引：$.user_id 與 $.uid', async () => {
    const details = (await plan(OAUTH_MODELS_ERASE_SQL)).join('\n');
    expect(details).toMatch(/idx_oauth_models_user_id/);
    expect(details).toMatch(/idx_oauth_models_uid/);
  });
});
