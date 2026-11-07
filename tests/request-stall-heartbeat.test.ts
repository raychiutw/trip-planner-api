/**
 * 外部心跳（trip-planner#1623）：agent／Mac 掛掉時，請求長時間無人處理要告警。
 * 真 SQLite + 假 fetch（Telegram）。守衛：超過門檻才告警、狀態變化才發、未設定靜默、
 * 恢復通知、已收屍（failed）的請求不算停滯。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkRequestStall } from '../src/lib/request-stall-heartbeat';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let sent: string[];
const tg = { TELEGRAM_BOT_TOKEN: 'tok-secret', TELEGRAM_CHAT_ID: 'chat-secret' };
const mkEnv = (extra: Partial<Env> = {}) => ({ DB: d1.db, ...tg, ...extra }) as Env;
const insert = (status: string, ageMin: number, extra = '') =>
  d1.raw.prepare(
    `INSERT INTO trip_requests (trip_id, message, status, created_at${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ('t1', '使用者私密內容', ?, datetime('now', ?)${extra ? ', datetime(\'now\', \'' + extra.split('=')[1] + '\')' : ''})`,
  ).run(status, `-${ageMin} minutes`);

beforeEach(() => {
  d1 = createD1();
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).text);
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { d1.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('checkRequestStall', () => {
  it('超過門檻（預設 30 分鐘）的 open 請求 → 告警，內容不含使用者內容與憑證', async () => {
    insert('open', 45);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/停滯/);
    expect(sent[0]).not.toMatch(/私密|tok-secret|chat-secret/);
  });

  it('processing 且超過門檻也算', async () => {
    insert('processing', 45);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(1);
  });

  it('未超過門檻不告警', async () => {
    insert('open', 10);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(0);
  });

  it('門檻可由 REQUEST_STALL_THRESHOLD_MINUTES 調整', async () => {
    insert('open', 10);
    await checkRequestStall(mkEnv({ REQUEST_STALL_THRESHOLD_MINUTES: '5' }));
    expect(sent).toHaveLength(1);
  });

  it('已收屍（failed／timed_out）與已完成的請求不算停滯', async () => {
    insert('failed', 120);
    insert('completed', 120);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(0);
  });

  it('processing 但最近有更新（updated_at 在門檻內）不算停滯', async () => {
    insert('processing', 80, "updated_at=-5 minutes");
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(0);
  });

  it('持續停滯只發一次（狀態變化才發）', async () => {
    insert('open', 45);
    await checkRequestStall(mkEnv());
    await checkRequestStall(mkEnv());
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(1);
  });

  it('恢復時發一則恢復通知，之後不再發', async () => {
    insert('open', 45);
    await checkRequestStall(mkEnv());
    d1.raw.prepare("UPDATE trip_requests SET status = 'completed'").run();
    await checkRequestStall(mkEnv());
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/解除|恢復/);
  });

  it('恢復後再次停滯會再告警', async () => {
    insert('open', 45);
    await checkRequestStall(mkEnv());
    d1.raw.prepare("UPDATE trip_requests SET status = 'completed'").run();
    await checkRequestStall(mkEnv());
    insert('open', 45);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(3);
  });

  it('Telegram 未設定 → 靜默：不送、不寫狀態、不 log', async () => {
    insert('open', 45);
    await checkRequestStall({ DB: d1.db } as Env);
    await checkRequestStall({ DB: d1.db, TELEGRAM_BOT_TOKEN: 'x' } as Env);
    expect(sent).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(d1.raw.prepare('SELECT * FROM app_settings WHERE key LIKE ?').all('request_stall%')).toHaveLength(0);
  });

  it('設定後才補上 Telegram：之前靜默期間的停滯會在第一次檢查告警', async () => {
    insert('open', 45);
    await checkRequestStall({ DB: d1.db } as Env);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['Telegram 回 500', () => new Response('boom', { status: 500 })],
    ['fetch 拋錯（網路／逾時）', () => { throw new Error('network'); }],
  ])('%s：不寫已告警狀態，下一輪會再發', async (_n, fail) => {
    insert('open', 45);
    const ok = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => fail()));
    await checkRequestStall(mkEnv());
    expect(d1.raw.prepare('SELECT * FROM app_settings WHERE key = ?').all('request_stall_alerted')).toHaveLength(0);
    vi.stubGlobal('fetch', ok);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(1);
  });

  it('恢復通知送失敗：維持已告警狀態，下一輪重發恢復通知', async () => {
    insert('open', 45);
    await checkRequestStall(mkEnv());
    d1.raw.prepare("UPDATE trip_requests SET status = 'completed'").run();
    const ok = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    await checkRequestStall(mkEnv());
    vi.stubGlobal('fetch', ok);
    await checkRequestStall(mkEnv());
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/解除/);
  });
});
