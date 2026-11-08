/**
 * eraseUserAccount 清 rate_limit_buckets 不可受 email 長度限制（issue trip-planner#1630）。
 * 舊寫法 `bucket_key LIKE '%:<email>'` 在 D1 的 pattern 超過 50 bytes 時整批 500；
 * tests/support/d1.ts 已把 LIKE pattern 上限對齊 D1（50 bytes），所以這裡能重現。
 * 語意：刪「以 `:<email>` 結尾」的 bucket；ASCII 大小寫不分；email 內的 % _ 當字面字元。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { eraseUserAccount } from '../../src/lib/erasure';

let db: D1Database;
beforeAll(async () => { db = await createTestDb(); }, 60000);
afterAll(disposeMiniflare);

let seq = 0;
async function setup(email: string, buckets: string[], keep: string[]) {
  const uid = `erase-rl-${++seq}`;
  await db.prepare("INSERT INTO users (id, email, display_name, status) VALUES (?, ?, ?, 'active')").bind(uid, email, uid).run();
  for (const k of [...buckets, ...keep]) {
    await db.prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start) VALUES (?, 1, 0)').bind(k).run();
  }
  await eraseUserAccount(db, uid);
  const left = async (k: string) => (await db.prepare('SELECT 1 FROM rate_limit_buckets WHERE bucket_key = ?').bind(k).first()) !== null;
  return { gone: async () => (await Promise.all(buckets.map(left))).every((x) => !x),
           kept: async () => (await Promise.all(keep.map(left))).every((x) => x) };
}

// `%:` 佔 2 bytes，所以 email 48 bytes = pattern 50（舊寫法的最後一個可過），49 bytes 起失敗
const emailOf = (bytes: number) => `${'a'.repeat(bytes - '@x.io'.length)}@x.io`;

describe('eraseUserAccount：rate_limit_buckets 比對不受 email 長度限制', () => {
  for (const bytes of [30, 48, 49, 50, 51, 120, 254]) {
    it(`email ${bytes} bytes：刪帳號成功，只清該 email 的 bucket`, async () => {
      const email = emailOf(bytes);
      const s = await setup(email, [`forgot-password:${email}`, `send-verification:${email}`],
        [`forgot-password:other-${email}`, `login:ip-${bytes}`]);
      expect(await s.gone()).toBe(true);
      expect(await s.kept()).toBe(true);
    });
  }

  it('多位元組 email（pattern 以 bytes 計）：刪帳號成功', async () => {
    const email = `${'測'.repeat(20)}@例.tw`; // 約 70 bytes
    const s = await setup(email, [`forgot-password:${email}`], [`forgot-password:${email}x`, `forgot-password:${'測'.repeat(19)}@例.tw`]);
    expect(await s.gone()).toBe(true);
    expect(await s.kept()).toBe(true);
  });

  it('ASCII 大小寫不分（與 LIKE 一致）', async () => {
    const email = 'MiXed.Case@Example.com';
    const s = await setup(email, ['forgot-password:mixed.case@example.com', 'forgot-password:MIXED.CASE@EXAMPLE.COM'], []);
    expect(await s.gone()).toBe(true);
  });

  it('email 內的 % 與 _ 是字面字元，不當萬用字元去誤刪別人的 bucket', async () => {
    const email = 'a_b%c@x.io';
    const s = await setup(email, [`forgot-password:${email}`], ['forgot-password:aXb123c@x.io', 'forgot-password:a_b%cZ@x.io']);
    expect(await s.gone()).toBe(true);
    expect(await s.kept()).toBe(true);
  });

  it('長 email 含 % _ 也不受限', async () => {
    const email = `${'a_%'.repeat(20)}@x.io`;
    const s = await setup(email, [`forgot-password:${email}`], [`forgot-password:${'aZZ'.repeat(20)}@x.io`]);
    expect(await s.gone()).toBe(true);
    expect(await s.kept()).toBe(true);
  });
});
