/**
 * POST /api/invitations/accept — V2 共編邀請接受流程（走 HTTP 邊界，tests/api/http.ts）
 *
 * 需 session（真實 session cookie，經 middleware）+ user.email 必須 match invited_email（防 phishing：
 * 別人不能接走不屬於自己的邀請）+ atomic INSERT trip_permissions + UPDATE accepted_at。
 * 原本用 vi.doMock 換掉 _session 與手寫 mock DB；現在全部讀寫真實 D1，不再需要 module mock。
 *
 * 共用 D1：email／trip 一律用 `s15-` 前綴，結束時只清自己的資料。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, userIdFor } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';
import { INVITE_SECRET, seedInvitation } from './invitations-http';
import { cleanupS15 } from './cleanup-shares';

const owner = 's15-accept-owner@test.com';
const tripId = 's15-accept-trip';
let db: D1Database;
let api: Api;

async function accept(email: string | null, body: unknown): Promise<Response> {
  if (email === null) {
    // 沒有 bearer：直接 401
    return api.request('POST', '/api/invitations/accept', { json: body });
  }
  const session = await sessionFor(db, email);
  return api.request('POST', '/api/invitations/accept', { bearer: session.bearer, json: body });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function permissionRole(email: string): Promise<string | undefined> {
  const row = await db.prepare('SELECT role FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
    .bind(tripId, userIdFor(email)).first<{ role: string }>();
  return row?.role;
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET: INVITE_SECRET }) });
  await cleanupS15(db);
  await seedTrip(db, { id: tripId, owner });
});

afterAll(async () => {
  await cleanupS15(db);
  await disposeMiniflare();
});

describe('POST /api/invitations/accept', () => {
  it('401 AUTH_REQUIRED when no session', async () => {
    const res = await accept(null, { token: 't' });
    expect(res.status).toBe(401);
  });

  it('400 INVITATION_TOKEN_MISSING when token body missing', async () => {
    const res = await accept('s15-accept-missing@test.com', {});
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVITATION_TOKEN_MISSING');
  });

  it('410 INVITATION_INVALID when token_hash not found', async () => {
    const res = await accept('s15-accept-invalid@test.com', { token: 's15-fake-token' });
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_INVALID');
  });

  it('410 INVITATION_EXPIRED when expires_at < now，且不授予權限', async () => {
    const email = 's15-accept-expired@test.com';
    await seedUser(db, email);
    await seedInvitation(db, { tripId, token: 's15-expired-token', invitedEmail: email, invitedBy: owner, expiresAt: '2020-01-01T00:00:00Z' });
    const res = await accept(email, { token: 's15-expired-token' });
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_EXPIRED');
    expect(await permissionRole(email)).toBeUndefined();
  });

  it('410 INVITATION_ACCEPTED when already accepted，且不重複授予權限', async () => {
    const email = 's15-accept-done@test.com';
    await seedUser(db, email);
    await seedInvitation(db, { tripId, token: 's15-done-token', invitedEmail: email, invitedBy: owner, acceptedAt: '2026-04-26T10:00:00Z' });
    const res = await accept(email, { token: 's15-done-token' });
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('INVITATION_ACCEPTED');
    expect(await permissionRole(email)).toBeUndefined();
  });

  it('403 INVITATION_EMAIL_MISMATCH when session user.email != invited_email，邀請保持 pending', async () => {
    const wrong = 's15-accept-wrong@test.com';
    await seedUser(db, wrong);
    await seedInvitation(db, { tripId, token: 's15-mismatch-token', invitedEmail: 's15-accept-real-invitee@test.com', invitedBy: owner });
    const res = await accept(wrong, { token: 's15-mismatch-token' });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('INVITATION_EMAIL_MISMATCH');
    expect(await permissionRole(wrong)).toBeUndefined();
    const pending = await db.prepare('SELECT accepted_at FROM trip_invitations WHERE invited_email = ?')
      .bind('s15-accept-real-invitee@test.com').first<{ accepted_at: string | null }>();
    expect(pending?.accepted_at).toBeNull();
  });

  it('200 happy path: INSERT trip_permissions + UPDATE accepted_at + 稽核紀錄', async () => {
    const email = 's15-accept-ok@test.com';
    await seedUser(db, email);
    await seedInvitation(db, { tripId, token: 's15-ok-token', invitedEmail: email, invitedBy: owner });
    const res = await accept(email, { token: 's15-ok-token' });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; tripId: string; tripTitle: string };
    expect(json.ok).toBe(true);
    expect(json.tripId).toBe(tripId);
    expect(json.tripTitle).toBe(`Test Trip ${tripId}`);

    // 權限與 accepted 狀態在同一個 batch 落地
    expect(await permissionRole(email)).toBe('member');
    const inv = await db.prepare('SELECT accepted_at, accepted_by FROM trip_invitations WHERE invited_email = ?')
      .bind(email).first<{ accepted_at: string | null; accepted_by: string | null }>();
    expect(inv?.accepted_at).toBeTruthy();
    expect(inv?.accepted_by).toBe(userIdFor(email));
    const audit = await db.prepare("SELECT diff_json FROM audit_log WHERE trip_id = ? AND table_name = 'trip_invitations' AND changed_by = ?")
      .bind(tripId, email).first<{ diff_json: string }>();
    expect(audit?.diff_json).toContain('accepted');

    // 同一個 token 不能再用第二次，也不會重複出現權限列
    const replay = await accept(email, { token: 's15-ok-token' });
    expect(replay.status).toBe(410);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM trip_permissions WHERE trip_id = ? AND user_id = ?').bind(tripId, userIdFor(email)).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('DB 只存 HMAC(SESSION_SECRET, token)：raw token 當 token_hash 的列不能被接受；換 secret 也不能', async () => {
    const email = 's15-accept-hmac@test.com';
    await seedUser(db, email);
    // 洩漏情境：DB 列的 token_hash 欄位直接存 raw token（或攻擊者拿 hash 當 token）
    await db.prepare(`INSERT INTO trip_invitations (token_hash, trip_id, invited_email, role, invited_by, expires_at)
      VALUES (?, ?, ?, 'member', ?, '2099-01-01T00:00:00Z')`)
      .bind('s15-my-raw-xyz', tripId, email, userIdFor(owner)).run();
    const raw = await accept(email, { token: 's15-my-raw-xyz' });
    expect(raw.status).toBe(410);
    expect(await errorCode(raw)).toBe('INVITATION_INVALID');
    expect(await permissionRole(email)).toBeUndefined();

    // 正確 token 對不同 SESSION_SECRET 的伺服器無效
    const email2 = 's15-accept-hmac2@test.com';
    await seedUser(db, email2);
    await seedInvitation(db, { tripId, token: 's15-hmac-token', invitedEmail: email2, invitedBy: owner });
    const otherApi = createApi({ env: mockEnv(db, { SESSION_SECRET: 'a-different-session-secret-32-chars' }) });
    const session = await sessionFor(db, email2);
    const res = await otherApi.request('POST', '/api/invitations/accept', { bearer: session.bearer, json: { token: 's15-hmac-token' } });
    expect(res.status).toBe(410);
    expect(await permissionRole(email2)).toBeUndefined();
  });

  it('email match is case-insensitive (invited_email lowercase guaranteed by INSERT)', async () => {
    const mixed = 'S15-Accept-Case@Test.com';
    await seedUser(db, mixed);
    await seedInvitation(db, { tripId, token: 's15-case-token', invitedEmail: mixed.toLowerCase(), invitedBy: owner });
    const res = await accept(mixed, { token: 's15-case-token' });
    expect(res.status).toBe(200);
    expect(await permissionRole(mixed)).toBe('member');

    // 反向：DB 內的 invited_email 是大小寫混合（舊資料），使用者 email 為小寫，同樣比對成功
    const lower = 's15-accept-case2@test.com';
    await seedUser(db, lower);
    await seedInvitation(db, { tripId, token: 's15-case2-token', invitedEmail: 'S15-Accept-Case2@TEST.com', invitedBy: owner });
    expect((await accept(lower, { token: 's15-case2-token' })).status).toBe(200);
    expect(await permissionRole(lower)).toBe('member');
  });
});
