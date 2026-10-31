/** 行程權限判斷（自舊入口 _auth.ts 搬來，語意不變）。 */
import type { AuthData } from '../types';

export const TRIP_READ_SCOPE = 'trips:read';
export const TRIP_WRITE_SCOPE = 'trips:write';

/**
 * 三分法：第一方 session（scopes 為 undefined）／自家受限 token（有 restrictTrip）／第一方 client 直接通過；
 * 真正的第三方 OAuth token 必須帶對應 scope，空 scopes 一律拒絕（fail closed）。trips:write 隱含 trips:read。
 */
export function hasTripScope(auth: AuthData, required: string): boolean {
  const { scopes } = auth;
  if (scopes === undefined) return true;
  if (auth.restrictTrip !== undefined) return true;
  if (auth.isFirstPartyClient) return true;
  if (scopes.includes(required)) return true;
  return required === TRIP_READ_SCOPE && scopes.includes(TRIP_WRITE_SCOPE);
}

/** 該使用者在該行程有任何權限列（讀取權）。service token（沒有 user_id）一律 false。 */
export async function hasPermission(db: D1Database, auth: AuthData, tripId: string): Promise<boolean> {
  if (auth.isServiceToken) return false;
  if (!auth.userId) return false;
  if (auth.restrictTrip !== undefined && auth.restrictTrip !== tripId) return false;
  if (!hasTripScope(auth, TRIP_READ_SCOPE)) return false;
  const row = await db.prepare('SELECT 1 FROM trip_permissions WHERE user_id = ? AND trip_id = ?').bind(auth.userId, tripId).first();
  return !!row;
}
