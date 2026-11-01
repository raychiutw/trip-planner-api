/**
 * DELETE /api/permissions/:id — 移除權限
 * PATCH  /api/permissions/:id — 更新角色(member ↔ viewer)
 *
 * 授權：trip owner（Phase 3 移除全域 admin 後純 owner gate，見 ensureCanManageTripPerms）。
 * V2 共編改寫(task 5/9, 2026-04-27):拔掉 CF Access policy 同步(V2-P6
 * cutover 後 Access 已拆,呼叫 CF API 是死代碼 + 任何呼叫都會 fail)。
 *
 * v2.18.0:加 PATCH endpoint 配合 CollabPage role chip dropdown。
 *   - body: { role: 'member' | 'viewer' }
 *   - owner role 不可被改(只能 transfer ownership 走另外 endpoint)
 *   - 只能改成 member 或 viewer(防 client 偷送 'owner' 升級攻擊)
 */

import { ensureCanManageTripPerms } from '../permissions';
import { requireAuth } from '../../../lib/permissions';
import { logAudit } from '../../../lib/audit';
import { AppError } from '../../../errors';
import { json } from '../../../lib/utils';
import type { Env } from '../../../env';

const ALLOWED_PATCH_ROLES = new Set(['member', 'viewer']);

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const id = context.params.id as string;

  const record = await context.env.DB
    .prepare('SELECT * FROM trip_permissions WHERE id = ?')
    .bind(id)
    .first<{ id: number; trip_id: string; role: string }>();

  if (!record) {
    throw new AppError('DATA_NOT_FOUND', '找不到該權限記錄');
  }

  // PR-CC 2026-04-26：owner 不可被刪（含 self-delete）。要轉移 owner 走另外
  // endpoint（未來實作），不能直接 DELETE。
  if (record.role === 'owner') {
    throw new AppError('PERM_DENIED', '不可移除行程擁有者');
  }

  await ensureCanManageTripPerms(context, auth, record.trip_id);

  await context.env.DB.prepare('DELETE FROM trip_permissions WHERE id = ?').bind(id).run();

  await logAudit(context.env.DB, {
    tripId: record.trip_id,
    tableName: 'trip_permissions',
    recordId: record.id,
    action: 'delete',
    changedBy: auth.email,
    snapshot: JSON.stringify(record),
    diffJson: JSON.stringify({ role: record.role }),
  });

  return json({ ok: true });
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const id = context.params.id as string;
  const body = await context.request.json().catch(() => null) as { role?: unknown } | null;

  if (!body || typeof body.role !== 'string' || !ALLOWED_PATCH_ROLES.has(body.role)) {
    throw new AppError('DATA_VALIDATION', '只能改為 member 或 viewer');
  }
  const newRole = body.role as 'member' | 'viewer';

  const record = await context.env.DB
    .prepare('SELECT * FROM trip_permissions WHERE id = ?')
    .bind(id)
    .first<{ id: number; trip_id: string; role: string }>();

  if (!record) {
    throw new AppError('DATA_NOT_FOUND', '找不到該權限記錄');
  }

  // owner 角色不可改 — 只能 member ↔ viewer 互換（Phase 3：admin 角色已移除）。
  if (record.role === 'owner') {
    throw new AppError('PERM_DENIED', '不可修改行程擁有者的角色');
  }

  await ensureCanManageTripPerms(context, auth, record.trip_id);

  // No-op 直接回 200(避免 audit log noise)
  if (record.role === newRole) {
    return json({ ok: true, unchanged: true });
  }

  await context.env.DB
    .prepare('UPDATE trip_permissions SET role = ? WHERE id = ?')
    .bind(newRole, id)
    .run();

  await logAudit(context.env.DB, {
    tripId: record.trip_id,
    tableName: 'trip_permissions',
    recordId: record.id,
    action: 'update',
    changedBy: auth.email,
    snapshot: JSON.stringify({ ...record, role: newRole }),
    diffJson: JSON.stringify({ role: { from: record.role, to: newRole } }),
  });

  return json({ ok: true, role: newRole });
};
