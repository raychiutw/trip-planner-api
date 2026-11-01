/**
 * GET /api/invitations?token=xxx — V2 共編邀請查詢（走 HTTP 邊界，tests/api/http.ts）
 *
 * Lookup invitation by HMAC(SESSION_SECRET, raw_token) → trip_invitations row。
 * 三種失敗 case 共用 410 GONE：
 *   - INVITATION_INVALID  : token_hash 找不到 row
 *   - INVITATION_EXPIRED  : expires_at < now
 *   - INVITATION_ACCEPTED : accepted_at IS NOT NULL（避免重複觸發）
 * 另有 ?tripId=xxx 分支：trip owner 列出 pending 邀請（不含 raw token）。
 *
 * 原本用手寫 mock DB 檢查「bind 的參數是 hash 而非 raw token」「SQL 有 JOIN」；現在改成驗外部行為：
 * 讀真實 D1 的列，換 SESSION_SECRET／存 raw token 都查不到，標題與邀請者資訊來自 trips／users。
 *
 * 共用 D1：email／trip 一律用 `s15-` 前綴，結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser } from './helpers';
import { createApi, type Api } from './http';
import { INVITE_SECRET, seedInvitation } from './invitations-http';
import { cleanupS15 } from './cleanup-shares';
import { userIdFor } from './helpers';

const owner = 's15-get-owner@test.com';
const viewer = 's15-get-viewer@test.com';
const reader = 's15-get-reader@test.com';
const tripId = 's15-get-trip';
let db: D1Database;
let api: Api;

function preview(query: string, as = reader, target: Api = api): Promise<Response> {
  return target.get(`/api/invitations?${query}`, { as });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET: INVITE_SECRET }) });
  await cleanupS15(db);
  // 先建一個干擾行程（不同標題、不同擁有者），確認預覽的標題與邀請者來自邀請所屬的那一個
  await seedTrip(db, { id: 's15-get-decoy-trip', owner: 's15-get-decoy-owner@test.com' });
  await db.prepare('UPDATE trips SET title = ? WHERE id = ?').bind('DECOY-TITLE', 's15-get-decoy-trip').run();
  await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('DECOY-NAME', userIdFor('s15-get-decoy-owner@test.com')).run();
  await seedTrip(db, { id: tripId, owner });
  await seedUser(db, reader);
  await seedUser(db, viewer);
  await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('Ray', userIdFor(owner)).run();
  await db.prepare('UPDATE trips SET title = ? WHERE id = ?').bind('沖繩 5 日', tripId).run();
});

afterAll(async () => {
  await cleanupS15(db);
  await disposeMiniflare();
});

describe('GET /api/invitations', () => {
  it('400 when token query param missing', async () => {
    const res = await preview('');
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVITATION_TOKEN_MISSING');
  });

  it('500 when SESSION_SECRET not set (server misconfig)', async () => {
    const noSecret = createApi({ env: mockEnv(db) });
    const res = await preview('token=anything', reader, noSecret);
    expect(res.status).toBe(500);
  });

  it('未登入帶無效 token → 410（預覽是公開的，InvitePage 靠它顯示註冊／登入入口）', async () => {
    const res = await api.get('/api/invitations?token=s15-anon-fake');
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_INVALID');
  });

  it('未登入帶有效 token → 200 預覽，且回應不含 token 或 hash', async () => {
    await seedInvitation(db, { tripId, token: 's15-anon-valid', invitedEmail: 's15-anon-invitee@test.com', invitedBy: owner, expiresAt: '2099-05-04T10:00:00Z' });
    const res = await api.get('/api/invitations?token=s15-anon-valid');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('s15-anon-valid');
    expect(text.toLowerCase()).not.toContain('token');
    expect((JSON.parse(text) as { tripId: string }).tripId).toBe(tripId);
    // 後面的測試會列出這個行程的 pending 邀請，別留下這筆
    await db.prepare('DELETE FROM trip_invitations WHERE invited_email = ?').bind('s15-anon-invitee@test.com').run();
  });

  it('未登入同時帶 token 與 tripId → 仍需認證（不能借公開預覽列出 pending 邀請）', async () => {
    const res = await api.get(`/api/invitations?token=s15-anon-valid&tripId=${tripId}`);
    expect(res.status).toBe(401);
  });

  it('410 INVITATION_INVALID when token_hash not found', async () => {
    const res = await preview('token=s15-fake-token');
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_INVALID');
  });

  it('410 INVITATION_EXPIRED when expires_at in past', async () => {
    await seedInvitation(db, { tripId, token: 's15-get-expired', invitedEmail: 's15-get-expired-invitee@test.com', invitedBy: owner, expiresAt: '2020-01-01T00:00:00Z' });
    const res = await preview('token=s15-get-expired');
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_EXPIRED');
  });

  it('410 INVITATION_ACCEPTED when accepted_at is set', async () => {
    await seedInvitation(db, { tripId, token: 's15-get-accepted', invitedEmail: 's15-get-accepted-invitee@test.com', invitedBy: owner, acceptedAt: '2026-04-26T10:00:00Z' });
    const res = await preview('token=s15-get-accepted');
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_ACCEPTED');
  });

  it('200 happy path: returns trip preview + inviter info', async () => {
    await seedInvitation(db, { tripId, token: 's15-get-valid', invitedEmail: 's15-get-invitee@test.com', invitedBy: owner, expiresAt: '2099-05-04T10:00:00Z' });
    const res = await preview('token=s15-get-valid');
    expect(res.status).toBe(200);
    const json = await res.json() as {
      tripId: string; tripTitle: string; invitedEmail: string; role: string;
      inviterDisplayName: string; inviterEmail: string; expiresAt: string;
    };
    expect(json.tripId).toBe(tripId);
    expect(json.tripTitle).toBe('沖繩 5 日');
    expect(json.invitedEmail).toBe('s15-get-invitee@test.com');
    expect(json.role).toBe('member');
    expect(json.inviterDisplayName).toBe('Ray');
    expect(json.inviterEmail).toBe(owner);
    expect(json.expiresAt).toBe('2099-05-04T10:00:00Z');
    // 預覽不洩漏 token hash 或內部欄位
    const wire = JSON.stringify(json);
    expect(wire).not.toContain('token_hash');
    expect(wire).not.toContain('s15-get-valid');
  });

  it('查詢用 HMAC(SESSION_SECRET, raw_token)：存 raw token 的列、不同 SESSION_SECRET 都查不到', async () => {
    await db.prepare(`INSERT INTO trip_invitations (token_hash, trip_id, invited_email, role, invited_by, expires_at)
      VALUES (?, ?, ?, 'member', ?, '2099-01-01T00:00:00Z')`)
      .bind('s15-get-raw-xyz', tripId, 's15-get-raw-invitee@test.com', userIdFor(owner)).run();
    const raw = await preview('token=s15-get-raw-xyz');
    expect(raw.status).toBe(410);
    expect(await errorCode(raw)).toBe('INVITATION_INVALID');

    const otherSecret = createApi({ env: mockEnv(db, { SESSION_SECRET: 'a-different-session-secret-32-chars' }) });
    const res = await preview('token=s15-get-valid', reader, otherSecret);
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_INVALID');
  });

  it('標題與邀請者資訊來自 trips／users 的現值', async () => {
    await db.prepare('UPDATE trips SET title = ? WHERE id = ?').bind('改名後的行程', tripId).run();
    const res = await preview('token=s15-get-valid');
    expect(((await res.json()) as { tripTitle: string }).tripTitle).toBe('改名後的行程');
  });
});

describe('GET /api/invitations?tripId — owner 列出 pending 邀請', () => {
  it('owner 只看到 pending、含 isExpired／daysRemaining，且不含 raw token', async () => {
    const res = await api.get(`/api/invitations?tripId=${tripId}`, { as: owner });
    expect(res.status).toBe(200);
    const { items } = await res.json() as { items: { id: string; invitedEmail: string; isExpired: boolean; daysRemaining: number }[] };
    const emails = items.map((i) => i.invitedEmail).sort();
    // accepted 的 s15-get-accepted-invitee 不在列表內
    expect(emails).toEqual(['s15-get-expired-invitee@test.com', 's15-get-invitee@test.com', 's15-get-raw-invitee@test.com']);
    const expired = items.find((i) => i.invitedEmail === 's15-get-expired-invitee@test.com');
    expect(expired).toMatchObject({ isExpired: true, daysRemaining: 0 });
    const valid = items.find((i) => i.invitedEmail === 's15-get-invitee@test.com');
    expect(valid?.isExpired).toBe(false);
    expect(valid!.daysRemaining).toBeGreaterThan(0);
    expect(valid?.id).toMatch(/^[0-9a-f]{64}$|^[A-Za-z0-9_-]{20,}$/); // hash 當穩定識別碼，不是 raw token
    const wire = JSON.stringify(items);
    expect(wire).not.toContain('s15-get-valid');
    // 只回這幾個欄位：沒有 token、token_hash 這類敏感欄
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'daysRemaining', 'expiresAt', 'id', 'invitedEmail', 'isExpired']);
    }
  });

  it('非 owner（viewer 協作者、無關者）→ 403；未登入 → 401', async () => {
    await db.prepare("INSERT OR IGNORE INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'viewer')")
      .bind(userIdFor(viewer), tripId).run();
    expect((await api.get(`/api/invitations?tripId=${tripId}`, { as: viewer })).status).toBe(403);
    expect((await api.get(`/api/invitations?tripId=${tripId}`, { as: reader })).status).toBe(403);
    expect((await api.get(`/api/invitations?tripId=${tripId}`)).status).toBe(401);
  });
});
