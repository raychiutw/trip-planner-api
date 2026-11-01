/**
 * PATCH /api/account/profile — 更新登入 user 的 profile (v2.33.122)
 *
 * 目前只支援 display_name。未來可擴 avatar_url / bio 等欄位。
 *
 * Body: { displayName?: string | null }
 *   - string: trim 後寫入（max 50 chars，empty string 視同 clear）
 *   - null / 空字串: 設 NULL（fallback 規則：sidebar / AccountPage hero 顯 email local-part）
 *   - 欄位省略：不更新該欄位（將來多欄位時用）
 *
 * Response: 200 + updated user shape mirror /api/oauth/userinfo
 */
import { requireAuth, assertNotTripRestricted } from '../../../lib/permissions';
import { AppError } from '../../../errors';
import { json, parseJsonBody } from '../../../lib/utils';
import { logAudit } from '../../../lib/audit';
import type { Env } from '../../../env';

const MAX_DISPLAY_NAME_LEN = 50;

interface ProfilePatchBody {
  displayName?: string | null;
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  if (!auth.userId) {
    throw new AppError('AUTH_REQUIRED');
  }
  // restrict_trip token 是行程範圍的受限身份，不得改擁有者帳號資料（defense-in-depth）
  assertNotTripRestricted(auth);

  const body = await parseJsonBody<ProfilePatchBody>(context.request);

  // Validate + normalize displayName
  let nextDisplayName: string | null | undefined;
  if (body.displayName === undefined) {
    nextDisplayName = undefined; // 未提供 → 不更新
  } else if (body.displayName === null) {
    nextDisplayName = null; // 明確 clear
  } else if (typeof body.displayName !== 'string') {
    throw new AppError('DATA_VALIDATION', 'displayName 必須是 string 或 null');
  } else {
    const trimmed = body.displayName.trim();
    if (trimmed.length === 0) {
      nextDisplayName = null; // empty 視同 clear
    } else if (trimmed.length > MAX_DISPLAY_NAME_LEN) {
      throw new AppError(
        'DATA_VALIDATION',
        `displayName 最多 ${MAX_DISPLAY_NAME_LEN} 字`,
      );
    } else {
      nextDisplayName = trimmed;
    }
  }

  if (nextDisplayName === undefined) {
    throw new AppError('DATA_VALIDATION', '無有效欄位可更新');
  }

  const db = context.env.DB;
  await db
    .prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
    .bind(nextDisplayName, new Date().toISOString(), auth.userId)
    .run();

  // Audit log — table_name='user' 對齊既有 recordEmailEvent pattern
  await logAudit(db, {
    tripId: 'system',
    tableName: 'user',
    recordId: null,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({ displayName: nextDisplayName }),
  });

  // Re-fetch updated row + mirror /api/oauth/userinfo shape
  const row = await db
    .prepare(
      `SELECT id, email, email_verified_at, display_name, avatar_url, created_at
       FROM users WHERE id = ? LIMIT 1`,
    )
    .bind(auth.userId)
    .first<{
      id: string;
      email: string;
      email_verified_at: string | null;
      display_name: string | null;
      avatar_url: string | null;
      created_at: string;
    }>();

  if (!row) {
    throw new AppError('SYS_INTERNAL', '更新後找不到 user row');
  }

  return json({
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  });
};
