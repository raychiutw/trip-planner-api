/**
 * Integration test — PATCH /api/account/profile (v2.34.36 PR36)
 * 走 HTTP 邊界（tests/api/http.ts）：以真實 bearer token 認證，經真實路由與 middleware。
 *
 * 涵蓋 v2.33.122 display_name lifecycle:
 *   - trim 後寫入
 *   - max 50 chars cap (51+ chars → 400)
 *   - null / empty string 視同 clear (display_name=NULL)
 *   - 欄位省略（未提供）→ 400 無有效欄位
 *   - 非 string 型別 → 400 validation
 *   - 200 response mirror /api/oauth/userinfo shape (camelCase)
 *   - audit_log 紀錄 (tableName='user' + diffJson 含 displayName)
 *   - unauthenticated → 401 AUTH_REQUIRED
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedUser } from './helpers';
import { createApi, type Api } from './http';

let db: D1Database;
let api: Api;
// 共用 D1：專用 email，結束時清掉自己的資料
const userEmail = 'profile-test@example.com';
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  userId = await seedUser(db, userEmail);
});

afterAll(async () => {
  await db.prepare(`DELETE FROM audit_log WHERE table_name = 'user' AND changed_by = ?`).bind(userEmail).run();
  await db.prepare(`DELETE FROM oauth_models WHERE name = 'AccessToken' AND json_extract(payload, '$.user_id') = ?`).bind(userId).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  await disposeMiniflare();
});

async function callPatch(body: Record<string, unknown>, email = userEmail) {
  return api.request('PATCH', '/api/account/profile', { as: email, json: body });
}

async function fetchUser() {
  return db
    .prepare('SELECT display_name, updated_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string | null; updated_at: string | null }>();
}

async function fetchAuditRows() {
  const rs = await db
    .prepare(
      `SELECT action, table_name AS tableName, record_id AS recordId, changed_by AS changedBy, diff_json AS diffJson
       FROM audit_log WHERE table_name = 'user' AND changed_by = ? ORDER BY id ASC`,
    )
    .bind(userEmail)
    .all<{ action: string; tableName: string; recordId: number | null; changedBy: string; diffJson: string }>();
  return rs.results ?? [];
}

describe('PATCH /api/account/profile — 認證', () => {
  it('未登入 → 401 AUTH_REQUIRED，且資料不動', async () => {
    const before = await fetchUser();
    const res = await api.request('PATCH', '/api/account/profile', { json: { displayName: 'anon' }  });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_REQUIRED');
    expect(await fetchUser()).toEqual(before);
  });
});

describe('PATCH /api/account/profile — restrict_trip containment（defense-in-depth）', () => {
  it('受限 token 改帳號名稱 → 403（不得以行程受限身份改擁有者資料）', async () => {
    await callPatch({ displayName: 'before-hijack' });
    const resp = await api.request('PATCH', '/api/account/profile', {
      as: userEmail,
      restrictTrip: 'some-trip',
      json: { displayName: 'hijack' },
    });
    expect(resp.status).toBe(403);
    expect((await fetchUser())!.display_name, '受限 token 不得改動資料').toBe('before-hijack');
  });
});

describe('PATCH /api/account/profile — display_name lifecycle', () => {
  it('字串 → trim 後寫入', async () => {
    const res = await callPatch({ displayName: '  Ray Chiu  ' });
    expect(res.status).toBe(200);
    const body = await res.json() as { displayName: string };
    expect(body.displayName).toBe('Ray Chiu');
    const row = await fetchUser();
    expect(row!.display_name).toBe('Ray Chiu');
  });

  it('null → clear (display_name=NULL)', async () => {
    await callPatch({ displayName: 'will be cleared' });
    const res = await callPatch({ displayName: null });
    expect(res.status).toBe(200);
    const body = await res.json() as { displayName: string | null };
    expect(body.displayName).toBeNull();
    const row = await fetchUser();
    expect(row!.display_name).toBeNull();
  });

  it('empty string → clear (display_name=NULL)', async () => {
    await callPatch({ displayName: 'will be cleared' });
    const res = await callPatch({ displayName: '   ' });
    expect(res.status).toBe(200);
    const body = await res.json() as { displayName: string | null };
    expect(body.displayName).toBeNull();
  });

  it('50 chars 邊界 OK', async () => {
    const name = 'x'.repeat(50);
    const res = await callPatch({ displayName: name });
    expect(res.status).toBe(200);
    const body = await res.json() as { displayName: string };
    expect(body.displayName).toBe(name);
  });

  it('51 chars → 400 DATA_VALIDATION + detail 含 50', async () => {
    // AppError: error.message=generic, error.detail=specific(handler-supplied)
    const name = 'x'.repeat(51);
    const res = await callPatch({ displayName: name });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
    expect(body.error.detail).toContain('50');
  });

  it('欄位省略（body 空）→ 400 無有效欄位可更新', async () => {
    const res = await callPatch({});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('非 string 型別（number）→ 400', async () => {
    const res = await callPatch({ displayName: 123 });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('DATA_VALIDATION');
  });

  it('response mirror /api/oauth/userinfo shape (camelCase + emailVerified)', async () => {
    const res = await callPatch({ displayName: 'Test User' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('email', userEmail);
    expect(body).toHaveProperty('emailVerified');
    expect(body).toHaveProperty('displayName', 'Test User');
    expect(body).toHaveProperty('avatarUrl');
    expect(body).toHaveProperty('createdAt');
    // snake_case 欄位不應出現
    expect(body).not.toHaveProperty('display_name');
    expect(body).not.toHaveProperty('email_verified_at');
    expect(body).not.toHaveProperty('avatar_url');
    expect(body).not.toHaveProperty('created_at');
  });

  it('emailVerified 反映 email_verified_at（已驗證 → true，未驗證 → false）', async () => {
    const before = await callPatch({ displayName: 'verify-check' });
    expect((await before.json() as { emailVerified: boolean }).emailVerified).toBe(false);
    await db.prepare(`UPDATE users SET email_verified_at = datetime('now') WHERE id = ?`).bind(userId).run();
    const after = await callPatch({ displayName: 'verify-check' });
    expect((await after.json() as { emailVerified: boolean }).emailVerified).toBe(true);
    await db.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').bind(userId).run();
  });

  it('audit_log 寫入 (tableName=user + action=update + diffJson 含 displayName)', async () => {
    const before = await fetchAuditRows();
    const res = await callPatch({ displayName: 'Audit Test' });
    expect(res.status).toBe(200);
    const after = await fetchAuditRows();
    expect(after.length).toBe(before.length + 1);
    const last = after[after.length - 1]!;
    expect(last.tableName).toBe('user');
    expect(last.action).toBe('update');
    expect(last.changedBy).toBe(userEmail);
    expect(last.diffJson).toContain('Audit Test');
  });
});
