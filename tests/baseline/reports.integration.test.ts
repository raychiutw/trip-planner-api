/**
 * Integration test — POST /api/reports
 * 走 HTTP 邊界（tests/api/http.ts）。這是公開端點（不需認證），瀏覽器送出時會帶 Origin；
 * 共用 D1 用 s16- 專屬 trip id 與專屬來源 IP（rate limit bucket 以 IP 計）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

const TRIP = 's16-report-trip';
const OWNER = 's16-report-owner@test.com';
const BROWSER_ORIGIN = 'https://trip-planner-dby.pages.dev';
const IP = '10.16.0.1';
const LOCKED_IP = '10.16.0.2';

let db: D1Database;
let api: Api;

function post(body: unknown, ip = IP) {
  return api.request('POST', '/api/reports', { json: body, headers: { Origin: BROWSER_ORIGIN, 'CF-Connecting-IP': ip } });
}

async function reportCount(): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM error_reports WHERE trip_id = ?').bind(TRIP).first<{ c: number }>();
  return row!.c;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { ALLOWED_ORIGINS: 'https://trip-planner-dby.pages.dev' }) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
});

afterAll(async () => {
  await db.prepare('DELETE FROM error_reports WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'reports:ip:10.16.%'").run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

describe('POST /api/reports', () => {
  it('正常回報 → 201', async () => {
    const resp = await post({
      tripId: TRIP,
      url: 'https://example.com/trip/s16-report-trip',
      errorCode: 'DATA_NOT_FOUND',
      errorMessage: '找不到這筆資料',
      userAgent: 'Mozilla/5.0',
      context: '{"dayNum":1}',
    });
    expect(resp.status).toBe(201);

    const row = await db.prepare('SELECT * FROM error_reports WHERE trip_id = ? AND url = ?')
      .bind(TRIP, 'https://example.com/trip/s16-report-trip').first();
    expect(row).not.toBeNull();
    expect((row as Record<string, unknown>).error_code).toBe('DATA_NOT_FOUND');
  });

  it('缺 tripId → 400', async () => {
    const resp = await post({ url: 'https://example.com' });
    expect(resp.status).toBe(400);
  });

  it('蜜罐欄位 → 假裝成功但不存', async () => {
    const before = await reportCount();
    const resp = await post({ tripId: TRIP, website: 'http://spam.com' });
    expect(resp.status).toBe(200);
    expect(await reportCount()).toBe(before);
  });

  it('30 秒內重複 → 429', async () => {
    const body = {
      tripId: TRIP,
      url: 'https://example.com/trip/s16-report-trip/dup-test',
      errorCode: 'SYS_INTERNAL',
    };
    expect((await post(body)).status).toBe(201);
    const resp = await post(body);
    expect(resp.status).toBe(429);
    const row = await db.prepare('SELECT COUNT(*) AS c FROM error_reports WHERE trip_id = ? AND url = ?')
      .bind(TRIP, body.url).first<{ c: number }>();
    expect(row!.c).toBe(1);
  });

  // 以下為 mutation 驗證發現的缺口
  it('tripId 不存在 → 回 201 但不寫入（不洩漏行程是否存在）', async () => {
    const resp = await post({ tripId: 's16-report-no-such-trip', url: 'https://example.com/none' });
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT COUNT(*) AS c FROM error_reports WHERE trip_id = ?')
      .bind('s16-report-no-such-trip').first<{ c: number }>();
    expect(row!.c).toBe(0);
  });

  it('來源 IP 的 bucket 已鎖定 → 429 RATE_LIMITED，且不寫入', async () => {
    await db.prepare('INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, ?, ?, ?)')
      .bind(`reports:ip:${LOCKED_IP}`, 201, Date.now(), Date.now() + 60_000).run();
    const url = 'https://example.com/trip/s16-report-trip/locked';
    const resp = await post({ tripId: TRIP, url }, LOCKED_IP);
    expect(resp.status).toBe(429);
    expect(await resp.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    const row = await db.prepare('SELECT COUNT(*) AS c FROM error_reports WHERE trip_id = ? AND url = ?')
      .bind(TRIP, url).first<{ c: number }>();
    expect(row!.c).toBe(0);
  });

  it('欄位清洗：換行壓成空白、超過 2000 字截斷', async () => {
    const url = 'https://example.com/trip/s16-report-trip/clamp';
    const resp = await post({ tripId: TRIP, url, errorMessage: `第一行\n第二行${'x'.repeat(2100)}` });
    expect(resp.status).toBe(201);
    const row = await db.prepare('SELECT error_message FROM error_reports WHERE trip_id = ? AND url = ?')
      .bind(TRIP, url).first<{ error_message: string }>();
    expect(row!.error_message.startsWith('第一行 第二行')).toBe(true);
    expect(row!.error_message).not.toContain('\n');
    expect(row!.error_message.length).toBe(2000);
  });
});
