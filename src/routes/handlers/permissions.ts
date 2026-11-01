/**
 * GET  /api/permissions?tripId=xxx  — 列出行程權限
 * POST /api/permissions { email, tripId, role? } — 新增權限 / 寄邀請
 *
 * 授權：trip owner（Phase 3 移除全域 admin 後純 owner gate，見 ensureCanManageTripPerms）。
 * V2 共編分享信改寫（task 5/9, 2026-04-27）：拔 CF Access 死代碼（V2-P6 cutover 後
 * Access 已拆），改成兩條分支：
 *   - existing user (users.email match)：INSERT trip_permissions + 寄通知信「[Inviter]
 *     邀請你加入 [Trip]」（isExistingUser=true → CTA「登入並加入」）
 *   - new email：產 invitation token + INSERT trip_invitations + 寄含 signup link 的
 *     邀請信（isExistingUser=false → CTA「註冊並加入」）
 *
 * 兩條分支 response shape 對齊 anti-enumeration（status 區分但 201 + email 一致）。
 * Email 寄送 best-effort（失敗不 rollback）。
 */

import { logAudit, recordEmailEvent } from '../../lib/audit';
import { requireAuth, assertNotTripRestricted } from '../../lib/permissions';
import { alertAdminTelegram } from '../../lib/alert';
import { maskEmail } from '../../lib/pii';
import { AppError } from '../../errors';
import type { AuthData } from '../../types';
import { json, parseJsonBody, getPublicOrigin } from '../../lib/utils';
import { sendEmail, EmailError } from '../../lib/email';
import { tripInvitation } from '../../lib/email-templates';
import { normalizeEmail } from '../../lib/email-utils';
import {
  generateInvitationToken,
  invitationExpiresAt,
} from '../../lib/invitation-token';
import type { Env } from '../../env';

/** 檢查 auth user 是否為該 trip 的 owner（Phase 3：admin 移除，純 owner gate）。 */
export async function ensureCanManageTripPerms(
  context: { env: Env },
  auth: AuthData,
  tripId: string,
): Promise<void> {
  // v2.55.56: 受限 token（tp-request downscope）一律不可管理共編 — 邀請成員是持久性
  // 提權，就算對自己那個 trip 也不該讓被注入的自動化 agent 碰。
  assertNotTripRestricted(auth);
  // V2 cutover phase 2: 純 owner_user_id check (owner email column dropped)
  if (!auth.userId) throw new AppError('PERM_ADMIN_ONLY', '需 V2 OAuth 登入');
  const owner = await context.env.DB
    .prepare('SELECT owner_user_id FROM trips WHERE id = ?')
    .bind(tripId)
    .first<{ owner_user_id: string | null }>();
  if (!owner) throw new AppError('DATA_NOT_FOUND', '找不到該行程');
  if (owner.owner_user_id !== auth.userId) {
    throw new AppError('PERM_ADMIN_ONLY', '僅行程擁有者或管理者可操作共編');
  }
}

// GET /api/permissions?tripId=xxx
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const url = new URL(context.request.url);
  const tripId = url.searchParams.get('tripId');

  if (!tripId) {
    throw new AppError('DATA_VALIDATION', '缺少 tripId 參數');
  }

  await ensureCanManageTripPerms(context, auth, tripId);

  // V2 cutover phase 2: trip_permissions.email column dropped — JOIN users for display.
  // v2.31.35: 加 u.display_name 給 CollabPanel avatar initial 用（與 TripsListPage 一致）。
  const { results } = await context.env.DB
    .prepare(
      `SELECT tp.id, u.email, u.display_name, tp.trip_id, tp.role, tp.user_id
       FROM trip_permissions tp
       LEFT JOIN users u ON u.id = tp.user_id
       WHERE tp.trip_id = ?
       ORDER BY u.email`,
    )
    .bind(tripId)
    .all();

  return json(results);
};

/**
 * Best-effort send invitation email — 兩條分支共用。
 *
 * **Q7 best-effort exception**：trip_permissions / trip_invitations row 已寫入 DB，
 * email 失敗不 rollback、不 throw 500（user 已能看到 trip / 邀請可重寄）。
 * 但 silent-skip 反 pattern 已換掉：失敗時 audit_log + Telegram alert 給 admin
 * observable。
 */
async function sendInvitationEmailBestEffort(
  env: Env,
  params: {
    to: string;
    tripId: string;
    inviterEmail: string;
    inviteUrl: string;
    inviterDisplayName: string | null;
    tripTitle: string;
    isExistingUser: boolean;
  },
): Promise<void> {
  const tpl = tripInvitation({
    inviteUrl: params.inviteUrl,
    inviterDisplayName: params.inviterDisplayName,
    inviterEmail: params.inviterEmail,
    tripTitle: params.tripTitle,
    isExistingUser: params.isExistingUser,
  });
  try {
    const result = await sendEmail(env, {
      to: params.to,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      template: 'invitation',
    });
    await recordEmailEvent(env.DB, {
      template: 'invitation',
      recipient: params.to,
      status: 'sent',
      tripId: params.tripId,
      triggeredBy: params.inviterEmail,
      latencyMs: result.elapsed,
    });
  } catch (emailErr) {
    const msg = emailErr instanceof EmailError
      ? `${emailErr.status} ${emailErr.message}`
      : emailErr instanceof Error
        ? emailErr.message
        : String(emailErr);
    await recordEmailEvent(env.DB, {
      template: 'invitation',
      recipient: params.to,
      status: 'failed',
      error: msg,
      tripId: params.tripId,
      triggeredBy: params.inviterEmail,
    });
    await alertAdminTelegram(
      env,
      // ⚠ params.to 是**被邀請的第三方** email —— 那人還不是使用者、從沒同意過任何條款。
      // 絕不可把它送進境外 bot 聊天群。trip id 已足以定位問題。
      `行程邀請信寄送失敗: ${maskEmail(params.to)} (trip=${params.tripId}, ${msg})`,
    );
  }
}

// POST /api/permissions { email, tripId, role? }
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const body = await parseJsonBody<{ email?: string; tripId?: string; role?: string }>(
    context.request,
  );

  const { email, tripId, role = 'member' } = body;
  if (!email || !tripId) {
    throw new AppError('DATA_VALIDATION', '缺少必要欄位：email, tripId');
  }

  // v2.18.0:接受 viewer role(read-only collaborator)
  // Phase 3（移除全域 admin）：協作者 role 僅 member / viewer；owner 於建立行程時設定，
  // 不經邀請。migration 0080 已從 trip_permissions.role CHECK 移除 'admin'，此處同步拒絕。
  if (role !== 'member' && role !== 'viewer') {
    throw new AppError('DATA_VALIDATION', "role 必須為 'member' / 'viewer'");
  }

  await ensureCanManageTripPerms(context, auth, tripId);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('DATA_VALIDATION', 'email 格式不正確');
  }

  // v2.33.59 round 13: Unicode-correct (NFKC + casefold)
  const lowerEmail = normalizeEmail(email);

  // Lookup invited user — 決定走 existing-user vs new-email 分支
  // v2.33.98 security: SELECT email_verified_at 一起拿，Branch A 用 verified-guard
  // 防 attacker 預先 signup unverified 帳號 squat 別人 email，等 owner 邀請即取得權限。
  const invitedUser = await context.env.DB
    .prepare('SELECT id, display_name, email_verified_at FROM users WHERE email = ? LIMIT 1')
    .bind(lowerEmail)
    .first<{ id: string; display_name: string | null; email_verified_at: string | null }>();

  // Trip title + inviter info 兩條分支共用（寄信都需要）
  const [trip, inviter] = await Promise.all([
    context.env.DB
      .prepare('SELECT title FROM trips WHERE id = ?')
      .bind(tripId)
      .first<{ title: string }>(),
    context.env.DB
      .prepare('SELECT display_name, email FROM users WHERE email = ? LIMIT 1')
      .bind(normalizeEmail(auth.email))
      .first<{ display_name: string | null; email: string }>(),
  ]);
  const tripTitle = trip?.title ?? tripId;
  const inviterDisplayName = inviter?.display_name ?? null;
  const inviterEmail = inviter?.email ?? auth.email;

  if (invitedUser && invitedUser.email_verified_at) {
    // ===== Branch A: invited email 已註冊 + 已驗證 =====
    // V2 cutover phase 2: 純 user_id-keyed insert (email column dropped)
    // v2.33.98 security: 要求 email_verified_at 不 null — unverified 帳號 fall
    // back 到 Branch B (invitation token route)，invitee 點 link 才證明 mailbox
    // 所有權，預防 attacker 預先 signup unverified squat 別人 email。
    let permRow: { id: number };
    try {
      const row = await context.env.DB
        .prepare(
          `INSERT INTO trip_permissions (trip_id, role, user_id)
           VALUES (?, ?, ?) RETURNING *`,
        )
        .bind(tripId, role, invitedUser.id)
        .first<{ id: number }>();
      if (!row) throw new AppError('SYS_INTERNAL', 'INSERT RETURNING 未回傳資料');
      permRow = row;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw new AppError('DATA_CONFLICT', '此 email 已有此行程的權限');
      }
      throw err;
    }

    await logAudit(context.env.DB, {
      tripId,
      tableName: 'trip_permissions',
      recordId: permRow.id,
      action: 'insert',
      changedBy: auth.email,
      diffJson: JSON.stringify({ email: lowerEmail, role, source: 'direct_add' }),
    });

    // Best-effort send notification email（isExistingUser=true → CTA「登入並加入」）
    // 已註冊者直接 redirect /trips?selected=tripId（不需 token）
    await sendInvitationEmailBestEffort(context.env, {
      to: lowerEmail,
      tripId,
      inviterEmail,
      inviteUrl: `${getPublicOrigin(context.env, context.request)}/trips?selected=${encodeURIComponent(tripId)}`,
      inviterDisplayName,
      tripTitle,
      isExistingUser: true,
    });

    // v2.33.42 security audit fix: unify response shape with Branch B
    // (invitation_sent) — 之前 `status='permission_added'` vs `'invitation_sent'`
    // 給 user-enumeration oracle（任何 logged-in user 可探測任意 email 是否
    // 已註冊）。改回統一 `invitation_sent` + `permRow.id` 仍 surface 給呼叫端
    // (audit log / admin UI)。
    //
    // Field name `id` 為 permission table PK；GET /permissions 同 endpoint 列
    // permission rows 也用 `id` 對齊 — 保持 GET/POST shape 一致比強制 `permissionId`
    // 重命名更重要（naming-rules.md tripId 規則 specific 針對 trip identifier）。
    return new Response(
      JSON.stringify({
        ok: true,
        status: 'invitation_sent',
        email: lowerEmail,
        id: permRow.id,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }

  // ===== Branch B: invited email 未註冊 → 產 invitation token =====
  if (!context.env.SESSION_SECRET) {
    throw new AppError('SYS_INTERNAL', 'SESSION_SECRET 未設定');
  }

  // Need inviter user_id for invited_by FK
  const inviterRow = await context.env.DB
    .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
    .bind(normalizeEmail(auth.email))
    .first<{ id: string }>();
  if (!inviterRow) {
    throw new AppError('SYS_INTERNAL', '邀請者帳號不存在');
  }

  const { rawToken, tokenHash } = await generateInvitationToken(context.env.SESSION_SECRET);
  // v2.33.63 round 14d: 用 default (INVITATION_TTL_DAYS 常數) 取代寫死 7,
  // 避免 src/server/invitation-token.ts 常數改但這裡漂移。
  const expiresAt = invitationExpiresAt();

  try {
    await context.env.DB
      .prepare(
        `INSERT INTO trip_invitations (token_hash, trip_id, invited_email, role, invited_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(tokenHash, tripId, lowerEmail, role, inviterRow.id, expiresAt)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new AppError('DATA_CONFLICT', '此 email 已有 pending 邀請（請改用重寄）');
    }
    throw err;
  }

  await logAudit(context.env.DB, {
    tripId,
    tableName: 'trip_invitations',
    recordId: null,
    action: 'insert',
    changedBy: auth.email,
    diffJson: JSON.stringify({ invited_email: lowerEmail, role, expires_at: expiresAt }),
  });

  // Best-effort send invitation email（含 raw token in URL）
  await sendInvitationEmailBestEffort(context.env, {
    to: lowerEmail,
    tripId,
    inviterEmail,
    inviteUrl: `${getPublicOrigin(context.env, context.request)}/invite?token=${encodeURIComponent(rawToken)}`,
    inviterDisplayName,
    tripTitle,
    isExistingUser: false,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      status: 'invitation_sent',
      email: lowerEmail,
      expiresAt,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
};
