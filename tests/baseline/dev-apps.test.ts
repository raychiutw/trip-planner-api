/**
 * /api/dev/apps — V2-P4 OAuth client_app management
 * 走 HTTP 邊界（tests/api/http.ts）：session 是真實簽出的 cookie + session_devices 資料列；
 * 原本檢查手寫 mock DB「prepare／bind 呼叫形狀」的斷言，改讀真實 D1 的 client_apps 資料列。
 * 共用 D1：專用 id／email（s16-dev-），結束時清掉自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';

const SESSION_SECRET = 'test-secret-32-chars-long-enough';
const U1 = 's16-dev-user-1';
const U2 = 's16-dev-user-2';
const EMAIL1 = 's16-dev-user-1@example.com';
const EMAIL2 = 's16-dev-user-2@example.com';

let db: D1Database;
let api: Api;
let cookie1: string;

type AppRow = {
  client_id: string; client_secret_hash: string | null; client_type: string; owner_user_id: string | null;
  status: string; redirect_uris: string; allowed_scopes: string; app_name: string;
  homepage_url: string | null; app_description: string | null;
};
async function appRow(clientId: string): Promise<AppRow | null> {
  return db.prepare('SELECT * FROM client_apps WHERE client_id = ?').bind(clientId).first<AppRow>();
}

async function cleanup() {
  await db.prepare('DELETE FROM client_apps WHERE owner_user_id IN (?, ?)').bind(U1, U2).run();
}

function seedApp(clientId: string, ownerId: string, overrides: Partial<{ redirect_uris: string; allowed_scopes: string; created_at: string; name: string }> = {}) {
  return db.prepare(
    `INSERT INTO client_apps (client_id, client_type, app_name, redirect_uris, allowed_scopes, owner_user_id, status, created_at)
     VALUES (?, 'public', ?, ?, ?, ?, 'active', ?)`,
  ).bind(
    clientId, overrides.name ?? 'My App',
    overrides.redirect_uris ?? '["https://example.com/cb"]',
    overrides.allowed_scopes ?? '["openid","profile"]',
    ownerId, overrides.created_at ?? '2026-04-20 00:00:00',
  ).run();
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET }) });
  cookie1 = (await sessionFor(db, EMAIL1, U1)).bearer;
  await sessionFor(db, EMAIL2, U2);
}, 30000);

afterAll(async () => {
  await cleanup();
  await db.prepare('DELETE FROM session_devices WHERE user_id IN (?, ?)').bind(U1, U2).run();
  await db.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(U1, U2).run();
  await disposeMiniflare();
});

describe('POST /api/dev/apps', () => {
  it('401 when no session cookie', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      
      json: { app_name: 'X', redirect_uris: ['https://x.com/cb'] },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('400 DATA_VALIDATION when app_name missing', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { redirect_uris: ['https://x.com/cb'] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
  });

  it('400 DATA_VALIDATION when redirect_uris missing or empty', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { app_name: 'My App', redirect_uris: [] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
  });

  it('400 DATA_VALIDATION when redirect_uri is non-https (except localhost)', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { app_name: 'My App', redirect_uris: ['http://attacker.com/cb'] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
    // 被拒絕的註冊不得留下任何資料列
    const rows = await db.prepare('SELECT COUNT(*) AS c FROM client_apps WHERE owner_user_id = ? AND app_name = ?').bind(U1, 'My App').first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  it('localhost redirect_uri is allowed (dev compat)', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { app_name: 'Dev App', redirect_uris: ['http://localhost:3000/cb'] },
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { client_id: string };
    expect((await appRow(json.client_id))?.redirect_uris).toBe('["http://localhost:3000/cb"]');
  }, 30_000);

  it('201 returns client_id (always) + null client_secret for public client', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1,
      json: { app_name: 'Public Mobile App', client_type: 'public', redirect_uris: ['https://example.com/cb'] },
    });
    expect(res.status).toBe(201);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json.client_id).toBe('string');
    expect((json.client_id as string).startsWith('tp_')).toBe(true);
    expect(json.client_secret).toBeNull();
    expect(json.client_type).toBe('public');
    expect(json.status).toBe('pending_review');
    const row = await appRow(json.client_id as string);
    expect(row).toMatchObject({ client_type: 'public', client_secret_hash: null, status: 'pending_review', app_name: 'Public Mobile App' });
  }, 30_000);

  it('201 returns client_secret ONCE for confidential client', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1,
      json: { app_name: 'Server Side App', client_type: 'confidential', redirect_uris: ['https://example.com/cb'] },
    });
    expect(res.status).toBe(201);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json.client_secret).toBe('string');
    expect((json.client_secret as string).startsWith('tps_')).toBe(true);
    // Verify hash (not plaintext) was stored in DB
    const row = await appRow(json.client_id as string);
    expect(row!.client_secret_hash).not.toBe(json.client_secret); // hash, not plaintext
    expect(row!.client_secret_hash).toMatch(/^pbkdf2\$/);
    expect(JSON.stringify(row)).not.toContain(json.client_secret as string);
    // 之後讀回（GET detail／list）不得再帶出 secret
    const list = await api.get('/api/dev/apps', { bearer: cookie1 });
    expect(JSON.stringify(await list.json())).not.toContain(json.client_secret as string);
  }, 30_000);

  it('owner_user_id = session uid (cannot override via body)', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1,
      json: { app_name: 'Test App', redirect_uris: ['https://x.com/cb'], owner_user_id: 'attacker-user-id' }, // ignored
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { client_id: string };
    expect((await appRow(json.client_id))?.owner_user_id).toBe(U1); // session uid, not 'attacker-user-id'
  }, 30_000);

  it('default scopes used when allowed_scopes not provided', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { app_name: 'Test App', redirect_uris: ['https://x.com/cb'] },
    });
    const json = await res.json() as { client_id: string; allowed_scopes: string[] };
    expect(json.allowed_scopes).toEqual(['openid', 'profile', 'email']);
    expect(JSON.parse((await appRow(json.client_id))!.allowed_scopes)).toEqual(['openid', 'profile', 'email']);
  }, 30_000);

  // mutation 驗證補的缺口：自助註冊不得拿到維運 scope（privilege escalation 防線）
  it.each(['companion', 'ops:maps', 'admin'])('allowed_scopes 含 %s → 400，不寫入資料列', async (scope) => {
    const name = `Scope Attack ${scope}`;
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { app_name: name, redirect_uris: ['https://x.com/cb'], allowed_scopes: ['openid', scope] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'DATA_VALIDATION' } });
    const rows = await db.prepare('SELECT COUNT(*) AS c FROM client_apps WHERE app_name = ?').bind(name).first<{ c: number }>();
    expect(rows!.c).toBe(0);
  });

  it('app_name 長度不足 → 400', async () => {
    const res = await api.request('POST', '/api/dev/apps', {
      bearer: cookie1, json: { app_name: 'X', redirect_uris: ['https://x.com/cb'] },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/dev/apps', () => {
  it('401 when no session', async () => {
    const res = await api.get('/api/dev/apps');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('200 returns user-owned apps with redirect_uris parsed from JSON', async () => {
    await cleanup();
    await seedApp('s16-dev-tp_abc', U1);
    const res = await api.get('/api/dev/apps', { bearer: cookie1 });
    expect(res.status).toBe(200);
    const json = await res.json() as { apps: Array<Record<string, unknown>> };
    expect(json.apps).toHaveLength(1);
    expect(json.apps[0]?.client_id).toBe('s16-dev-tp_abc');
    expect(json.apps[0]?.redirect_uris).toEqual(['https://example.com/cb']);
    expect(json.apps[0]?.allowed_scopes).toEqual(['openid', 'profile']);
    expect(json.apps[0]).not.toHaveProperty('client_secret_hash');
  });

  it('normalizes malformed historical JSON columns without hiding valid apps', async () => {
    await cleanup();
    await seedApp('s16-dev-tp_valid', U1, { redirect_uris: '["https://example.com/cb"]', allowed_scopes: '["openid"]', created_at: '2026-04-23 00:00:00' });
    await seedApp('s16-dev-tp_null', U1, { redirect_uris: 'null', allowed_scopes: '{}', created_at: '2026-04-22 00:00:00' });
    await seedApp('s16-dev-tp_mixed', U1, { redirect_uris: '["https://example.com/other",42,null]', allowed_scopes: '["profile",false]', created_at: '2026-04-21 00:00:00' });
    const res = await api.get('/api/dev/apps', { bearer: cookie1 });
    const json = await res.json() as { apps: Array<Record<string, unknown>> };
    expect(json.apps.map((app) => app.redirect_uris)).toEqual([
      ['https://example.com/cb'], [], ['https://example.com/other'],
    ]);
    expect(json.apps.map((app) => app.allowed_scopes)).toEqual([['openid'], [], ['profile']]);
  });

  it('filters by owner_user_id (session.uid)', async () => {
    await cleanup();
    await seedApp('s16-dev-tp_mine', U1);
    await seedApp('s16-dev-tp_theirs', U2, { name: 'Their App' });
    const res = await api.get('/api/dev/apps', { bearer: cookie1 });
    const json = await res.json() as { apps: Array<Record<string, unknown>> };
    expect(json.apps.map((app) => app.client_id)).toEqual(['s16-dev-tp_mine']);
  });
});
