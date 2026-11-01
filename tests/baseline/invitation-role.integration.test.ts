/**
 * 邀請角色（viewer／member／舊 admin）在真實 D1 的預覽與接受流程 — 走 HTTP 邊界（tests/api/http.ts）。
 * 預覽與接受都經過 middleware；接受用真實 session cookie（issueSession 寫入 session_devices）。
 *
 * 共用 D1：email／trip 一律用 `s15-` 前綴，結束時只清自己的資料。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, userIdFor } from './helpers';
import { sessionFor } from './account-session-helper';
import { createApi, type Api } from './http';
import { INVITE_SECRET, seedInvitation } from './invitations-http';
import { cleanupS15 } from './cleanup-shares';

const owner = 's15-invite-role-owner@test.com';
const invitee = 's15-invite-role-viewer@test.com';
const tripId = 's15-invitation-role-trip';
const token = 'invitation-role-viewer-token';
let db: D1Database;
let api: Api;

async function acceptAs(email: string, invitationToken = token): Promise<Response> {
  const session = await sessionFor(db, email);
  return api.request('POST', '/api/invitations/accept', { bearer: session.bearer, json: { token: invitationToken } });
}

async function previewAs(email: string, invitationToken: string): Promise<Response> {
  const session = await sessionFor(db, email);
  return api.get(`/api/invitations?token=${invitationToken}`, { bearer: session.bearer });
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET: INVITE_SECRET }) });
  await cleanupS15(db);
  await seedTrip(db, { id: tripId, owner });
  await seedUser(db, invitee);
  await seedInvitation(db, { tripId, token, invitedEmail: invitee, invitedBy: owner, role: 'viewer' });
});

afterAll(async () => {
  await cleanupS15(db);
  await disposeMiniflare();
});

describe('invitation role in real D1', () => {
  it('previews viewer role and grants viewer access once to the invited account', async () => {
    const preview = await previewAs(invitee, token);
    expect(preview.status).toBe(200);
    expect((await preview.json() as { role: string }).role).toBe('viewer');

    const wrong = await acceptAs(owner);
    expect(wrong.status).toBe(403);
    expect((await wrong.json() as { error: { code: string } }).error.code).toBe('INVITATION_EMAIL_MISMATCH');
    // 被拒絕的接受不能留下權限列
    expect(await db.prepare('SELECT 1 FROM trip_permissions WHERE trip_id = ? AND user_id = ? AND role != ?')
      .bind(tripId, userIdFor(owner), 'owner').first()).toBeNull();

    const accepted = await acceptAs(invitee);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, tripId });
    const permission = await db.prepare('SELECT role FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
      .bind(tripId, userIdFor(invitee)).first<{ role: string }>();
    expect(permission?.role).toBe('viewer');

    const replay = await acceptAs(invitee);
    expect(replay.status).toBe(410);
    expect((await replay.json() as { error: { code: string } }).error.code).toBe('INVITATION_ACCEPTED');
  });

  it('keeps legacy admin invitations acceptable as member', async () => {
    const legacyEmail = 's15-invite-role-legacy@test.com';
    const legacyToken = 'invitation-role-legacy-token';
    await seedUser(db, legacyEmail);
    await seedInvitation(db, { tripId, token: legacyToken, invitedEmail: legacyEmail, invitedBy: owner, role: 'admin' });
    const preview = await previewAs(legacyEmail, legacyToken);
    expect((await preview.json() as { role: string }).role).toBe('member');
    const accepted = await acceptAs(legacyEmail, legacyToken);
    expect(accepted.status).toBe(200);
    const permission = await db.prepare('SELECT role FROM trip_permissions WHERE trip_id = ? AND user_id = ?')
      .bind(tripId, userIdFor(legacyEmail)).first<{ role: string }>();
    expect(permission?.role).toBe('member');
  });

  it('接受後 viewer 能讀、不能寫：以真實 bearer 對行程操作', async () => {
    // 前一個測試已讓 invitee 成為 viewer
    const read = await api.get(`/api/trips/${tripId}`, { as: invitee });
    expect(read.status).toBe(200);
    // 管理分享連結是寫入層級的能力：viewer 被擋，沒有留下連結
    const write = await api.request('POST', `/api/trips/${tripId}/shares`, { as: invitee, json: {} });
    expect(write.status).toBe(403);
    const shares = await db.prepare('SELECT COUNT(*) AS n FROM trip_shares WHERE trip_id = ?').bind(tripId).first<{ n: number }>();
    expect(shares?.n).toBe(0);
  });
});
