/**
 * /api/account/notifications — user notification preference management.
 * 走 HTTP 邊界（tests/api/http.ts），session 為真實 cookie；
 * 原本檢查 mock DB「bind 呼叫形狀」的斷言，改讀真實 D1 的資料列。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';

const SESSION_SECRET = 'test-secret-32-chars-long-enough';
// 共用 D1：專用 id／email，結束時清掉自己的資料
const UID = 'notif-user-1';
const EMAIL = 'notif-user-1@example.com';
const URL_PATH = '/api/account/notifications';

let db: D1Database;
let api: Api;
let cookie: string;

type PrefRow = { trip_updates: number; invitations: number; system: number; updated_at: string };
async function prefRow(): Promise<PrefRow | null> {
  return db
    .prepare('SELECT trip_updates, invitations, system, updated_at FROM account_notification_preferences WHERE user_id = ?')
    .bind(UID)
    .first<PrefRow>();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET }) });
  cookie = (await sessionFor(db, EMAIL, UID)).bearer;
}, 30000);

beforeEach(async () => {
  await db.prepare('DELETE FROM account_notification_preferences WHERE user_id = ?').bind(UID).run();
});

afterAll(async () => {
  await db.prepare('DELETE FROM account_notification_preferences WHERE user_id = ?').bind(UID).run();
  await db.prepare('DELETE FROM session_devices WHERE user_id = ?').bind(UID).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(UID).run();
  await disposeMiniflare();
});

describe('GET /api/account/notifications', () => {
  it('401 when no session', async () => {
    const res = await api.get(URL_PATH);
    expect(res.status).toBe(401);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('AUTH_REQUIRED');
  });

  it('returns default enabled preferences when no row exists', async () => {
    const res = await api.get(URL_PATH, { bearer: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      preferences: {
        tripUpdates: true,
        invitations: true,
        system: true,
        updatedAt: null,
      },
    });
    // 只是讀取，不該順手寫入資料列
    expect(await prefRow()).toBeNull();
  });

  it('maps stored integer flags to booleans', async () => {
    await db.prepare(
      `INSERT INTO account_notification_preferences (user_id, trip_updates, invitations, system, updated_at)
       VALUES (?, 0, 1, 0, '2026-07-09T00:00:00Z')`,
    ).bind(UID).run();
    const res = await api.get(URL_PATH, { bearer: cookie });
    expect(await res.json()).toEqual({
      preferences: {
        tripUpdates: false,
        invitations: true,
        system: false,
        updatedAt: '2026-07-09T00:00:00Z',
      },
    });
  });
});

describe('PATCH /api/account/notifications', () => {
  it('rejects non-boolean preference values', async () => {
    const res = await api.request('PATCH', URL_PATH, { bearer: cookie, json: { tripUpdates: 'yes' } });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('DATA_VALIDATION');
    expect(await prefRow()).toBeNull();
  });

  it('rejects null bodies as validation errors', async () => {
    const res = await api.request('PATCH', URL_PATH, { bearer: cookie, json: null });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('DATA_VALIDATION');
  });

  it('returns a stable database error when the preferences table is not ready', async () => {
    // 對真實 D1 注入故障：碰到 account_notification_preferences 的 SQL 一律回「no such table」，
    // 模擬 code 先於 migration 部署（不改動共用 D1 的 schema）
    const realDb = db;
    const faulty = new Proxy(realDb, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('account_notification_preferences')) {
              throw new Error('D1_ERROR: no such table: account_notification_preferences');
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const faultyApi = createApi({ env: mockEnv(faulty, { SESSION_SECRET }) });
    const res = await faultyApi.request('PATCH', URL_PATH, { bearer: cookie, json: { system: false } });
    expect(res.status).toBe(503);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('SYS_DB_ERROR');
  });

  it('merges with stored preferences and upserts a full row', async () => {
    await db.prepare(
      `INSERT INTO account_notification_preferences (user_id, trip_updates, invitations, system, updated_at)
       VALUES (?, 1, 1, 0, '2026-07-08T00:00:00Z')`,
    ).bind(UID).run();

    const res = await api.request('PATCH', URL_PATH, { bearer: cookie, json: { invitations: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      preferences: {
        tripUpdates: true,
        invitations: false,
        system: false,
      },
    });

    // 真實資料列：完整合併後的整列，且 updated_at 已更新
    const row = await prefRow();
    expect(row).toMatchObject({ trip_updates: 1, invitations: 0, system: 0 });
    expect(row!.updated_at).not.toBe('2026-07-08T00:00:00Z');
    expect(typeof row!.updated_at).toBe('string');
  });

  it('沒有既有資料列時，PATCH 以預設值補齊並建立資料列', async () => {
    const res = await api.request('PATCH', URL_PATH, { bearer: cookie, json: { system: false } });
    expect(res.status).toBe(200);
    expect(await prefRow()).toMatchObject({ trip_updates: 1, invitations: 1, system: 0 });
  });

  it('未知欄位 → 400，且資料不動', async () => {
    const res = await api.request('PATCH', URL_PATH, { bearer: cookie, json: { system: false, bogus: true } });
    expect(res.status).toBe(400);
    expect(await prefRow()).toBeNull();
  });
});
