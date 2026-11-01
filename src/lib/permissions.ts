/**
 * Shared authorization helper for API write handlers.
 */
import { AppError } from '../errors';
import { getAuth } from './utils';
import type { AuthData } from '../env';

/**
 * Returns the authenticated AuthData or throws AUTH_REQUIRED.
 * Use in place of the repeated `const auth = getAuth(context); if (!auth) throw ...` pattern.
 */
export function requireAuth(context: { data: unknown }): AuthData {
  const auth = getAuth(context);
  if (!auth) throw new AppError('AUTH_REQUIRED');
  return auth;
}

/**
 * v2.55.56: reject a trip-scoped (tp-request downscope) token outright. Owner-level ops —
 * member management, trip creation/deletion — are outside a content-editing agent's remit
 * EVEN on its own trip: inviting a member or deleting the trip is persistent/destructive
 * escalation a prompt-injected agent must never reach. The per-trip content gates
 * (hasWritePermission / requireTripReadAccess / hasPermission) scope-match restrict_trip;
 * these owner gates don't route through them, so they call this guard directly. Unrestricted
 * tokens: no-op.
 */
export function assertNotTripRestricted(auth: AuthData): void {
  if (auth.restrictTrip !== undefined) {
    throw new AppError('PERM_DENIED', '受限 token 不可執行擁有者層級操作');
  }
}

/**
 * Service-token ops-scope check（移除全域 admin）。
 *
 * 「系統維運 / 跨-trip」端點的授權依據：只有 service token（client_credentials，
 * user_id=null）帶指定 ops scope 才為真。user-session 不帶 `scopes`（middleware
 * 只對 service token attach），故 user 一律回 false — 無法靠自帶 scope 偽造維運權限。
 */
export function hasOpsScope(auth: AuthData | null, scope: string): boolean {
  if (!auth?.isServiceToken) return false;
  const scopes = auth.scopes;
  if (!scopes) return false;
  return scopes.includes(scope);
}

/**
 * Scope gate：service token 帶指定 scope 才放行，否則 PERM_DENIED。
 * 用於 /api/admin/* 系統維運與跨-trip 端點（ops:*），以及 companion 端點
 * （PATCH /api/requests/:id — Claude CLI 回覆 chat）。
 */
export function requireScope(context: { data: unknown }, scope: string): AuthData {
  const auth = requireAuth(context);
  if (!hasOpsScope(auth, scope)) throw new AppError('PERM_DENIED');
  return auth;
}

/**
 * Master POI 寫入授權（PATCH / enrich 共用，F1）。
 * service token 帶 ops:poi → 放行（cron poi-refresh/backfill 維運，免 tripId）；
 * 否則 user 須提供 tripId + 對該 trip 有寫權限 + POI 確實屬於該 trip。
 */
export async function requirePoiWrite(
  db: D1Database,
  auth: AuthData,
  poiId: number,
  tripId: string | null | undefined,
): Promise<void> {
  if (hasOpsScope(auth, 'ops:poi')) return;
  if (!tripId) throw new AppError('DATA_VALIDATION', '非維運 token 必須提供 tripId');
  await requireTripWrite(db, auth, tripId);
  if (!(await verifyPoiBelongsToTrip(db, poiId, tripId))) {
    throw new AppError('PERM_DENIED', '此 POI 不屬於該行程');
  }
}

/**
 * Per-trip 寫權限 gate（owner/member，排除 viewer）。所有 per-trip 寫入 handler
 * （days／entries／notes／segments／shares／requests 等）與 requirePoiWrite 共用的唯一一份；
 * 不要在 handler 內嵌 hasWritePermission + PERM_DENIED（tests/unit/trip-write-gate-structure.test.ts 會擋）。
 */
export async function requireTripWrite(
  db: D1Database,
  auth: AuthData,
  tripId: string,
): Promise<void> {
  if (!(await hasWritePermission(db, auth, tripId))) throw new AppError('PERM_DENIED');
}


/* ═══════════ OAuth scope gate ═══════════════════════════════════════════
 * 2026-07-20 隱私盤點發現：三個權限 chokepoint 完全不檢查 scope，只看
 * trip_permissions.user_id。使用者在授權畫面只看到「openid 識別您的身分」就按同意，
 * 該第三方 app 實際上能讀寫他**全部行程**（含航班編號、訂房編號、緊急聯絡人電話）。
 * → 授權畫面的承諾與實際能力不符，隱私權政策照抄即為不實陳述。
 *
 * ⚠ 為什麼不是單純「require trips:read」：
 *   oauth/mint-restricted.ts 發給自家 AI pipeline 的 token 是 `scopes: []`
 *   （註解明言「能力純由 user_id + restrict_trip 決定」）。天真加 gate 會把
 *   「用對話改行程」整條線打掛。
 *
 * 所以是三分法，見 hasTripScope。
 * ══════════════════════════════════════════════════════════════════════ */

export const TRIP_READ_SCOPE = 'trips:read';
export const TRIP_WRITE_SCOPE = 'trips:write';

/**
 * 這個 auth 主體是否被授權對行程做 `required` 這件事。
 *
 * 1. **第一方 session**（`scopes === undefined`）→ true。
 *    middleware 的 session 路徑不 attach scopes（見 _middleware.ts 三個 attach 點），
 *    session 本身就是完整授權，不是委派。
 * 2. **自家受限 token**（有 `restrictTrip`）→ true。
 *    已被綁死在單一行程，比任何 scope 都嚴；實際的行程限制由呼叫端既有邏輯負責。
 * 3. **真正的第三方 OAuth token** → 必須帶對應 scope。空 scopes 一律拒絕（fail closed）。
 *
 * `trips:write` 隱含 `trips:read` —— 能寫的必然要能讀。
 */
export function hasTripScope(auth: AuthData, required: string): boolean {
  const { scopes } = auth;
  if (scopes === undefined) return true;                 // 第一方 session
  if (auth.restrictTrip !== undefined) return true;      // 自家受限 token
  // 第一方 client（tp-request AI pipeline）：授權來自 Consent + restrict_trip 而非 scopes。
  // 不豁免的話 /api/oauth/downscope（還沒拿到 restrictTrip 的那一步）會被擋，整條 pipeline 斷。
  if (auth.isFirstPartyClient) return true;
  if (scopes.includes(required)) return true;
  // 寫權隱含讀權
  return required === TRIP_READ_SCOPE && scopes.includes(TRIP_WRITE_SCOPE);
}

/**
 * Returns true if the authenticated user has any permission row on the given trip
 * (read access). viewer / member / owner roles all return true — viewer is read-allowed.
 * service tokens (no user_id) return false — 維運走 ops scope，不靠 trip membership。
 *
 * V2 cutover phase 2 (migration 0047): email column dropped from trip_permissions.
 * 純 user_id-based query。
 *
 * For write/destructive operations, use `hasWritePermission` instead.
 */
export async function hasPermission(
  db: D1Database,
  auth: AuthData,
  tripId: string,
): Promise<boolean> {
  if (auth.isServiceToken) return false;
  if (!auth.userId) return false;
  // v2.55.56: trip-scoped token (tp-request downscope) may only read its one trip —
  // completes the chokepoint set (hasWritePermission / requireTripReadAccess) so a
  // prompt-injected agent can't even read other trips' requests.
  if (auth.restrictTrip !== undefined && auth.restrictTrip !== tripId) return false;
  if (!hasTripScope(auth, TRIP_READ_SCOPE)) return false;
  const row = await db
    .prepare('SELECT 1 FROM trip_permissions WHERE user_id = ? AND trip_id = ?')
    .bind(auth.userId, tripId)
    .first();
  return !!row;
}

/**
 * v2.33.41 security audit: read-access gate for `/api/trips/:id/*` endpoints.
 * Accepts a request if:
 *   - the trip is `published=1` (public-share row), OR
 *   - the caller is authenticated AND has a `trip_permissions` row (any role).
 * service token (no user_id) → published-only（維運不讀個別 trip）。
 *
 * Throws `DATA_NOT_FOUND` 若 trip 不存在；throws `PERM_DENIED` 若需要 auth 卻無權。
 * 統一回 PERM_DENIED 而非 AUTH_REQUIRED 避免 enumerate published vs unpublished tripId。
 */
export async function requireTripReadAccess(
  db: D1Database,
  auth: AuthData | null,
  tripId: string,
): Promise<{ published: boolean; isMember: boolean }> {
  // v2.33.94 simplify: 從 2 個 sequential SELECT 合成 1 LEFT JOIN。
  const userIdForJoin = auth?.userId ?? '__no_match__';
  const row = await db
    .prepare(
      `SELECT t.published, tp.user_id AS perm_user_id
       FROM trips t
       LEFT JOIN trip_permissions tp ON tp.trip_id = t.id AND tp.user_id = ?
       WHERE t.id = ?`,
    )
    .bind(userIdForJoin, tripId)
    .first<{ published: number | null; perm_user_id: string | null }>();
  if (!row) throw new AppError('DATA_NOT_FOUND');
  // v2.55.56: a trip-scoped token (tp-request downscope) may only touch its one
  // trip — deny any other tripId, BEFORE the published short-circuit so a restricted
  // agent can't even read other public trips.
  if (auth?.restrictTrip !== undefined && auth.restrictTrip !== tripId) {
    throw new AppError('PERM_DENIED');
  }
  // scope gate 放在 published 短路**之前**：沒有 trips:read 的第三方 token
  // 連公開行程也不該透過本站 API 讀 —— 公開分享有自己的 /s/:token 路徑。
  if (auth && !hasTripScope(auth, TRIP_READ_SCOPE)) throw new AppError('PERM_DENIED');
  const published = row.published === 1;
  if (published) return { published: true, isMember: false };
  if (!auth) throw new AppError('PERM_DENIED');
  if (auth.isServiceToken) throw new AppError('PERM_DENIED');
  if (!auth.userId || row.perm_user_id === null) throw new AppError('PERM_DENIED');
  return { published: false, isMember: true };
}

/**
 * Returns true if the authenticated user can write to the given trip.
 * viewer role is BLOCKED here per migration 0043 ("viewer = read-only collaborator").
 * owner / member roles return true. service tokens (no user_id) return false — 維運走 ops scope。
 *
 * V2 cutover phase 2: 純 user_id-based query (email column 已 dropped)。
 */
export async function hasWritePermission(
  db: D1Database,
  auth: AuthData,
  tripId: string,
): Promise<boolean> {
  if (auth.isServiceToken) return false;
  if (!auth.userId) return false;
  // v2.55.56: trip-scoped token (tp-request downscope) may only write its one trip —
  // denies cross-trip writes at the API (confused deputy). Defense-in-depth, NOT a
  // containment boundary against a shell agent that can re-mint — see oauth/downscope.ts.
  if (auth.restrictTrip !== undefined && auth.restrictTrip !== tripId) return false;
  if (!hasTripScope(auth, TRIP_WRITE_SCOPE)) return false;
  const row = await db
    .prepare("SELECT 1 FROM trip_permissions WHERE user_id = ? AND trip_id = ? AND role != 'viewer'")
    .bind(auth.userId, tripId)
    .first();
  return !!row;
}

/**
 * Verifies that an entry belongs to the given trip via day_id → days.trip_id.
 */
export async function verifyEntryBelongsToTrip(
  db: D1Database,
  entryId: number,
  tripId: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM trip_entries e JOIN trip_days d ON e.day_id = d.id WHERE e.id = ? AND d.trip_id = ?')
    .bind(entryId, tripId)
    .first();
  return !!row;
}

/**
 * Verifies that a POI is attached to a trip, either as a canonical entry POI
 * (`trip_entry_pois`) or as the day-level hotel (`trip_days.hotel_poi_id`).
 *
 * v2.29.0: trip_pois 整表 DROPPED. verifyTripPoiBelongsToTrip removed (no
 * trip_pois.id 可查); all callers go through this function instead.
 */
export async function verifyPoiBelongsToTrip(
  db: D1Database,
  poiId: number,
  tripId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1
       FROM trip_entry_pois tep
       JOIN trip_entries e ON e.id = tep.entry_id
       JOIN trip_days d ON d.id = e.day_id
       WHERE tep.poi_id = ? AND d.trip_id = ?
       UNION ALL
       SELECT 1
       FROM trip_days td
       WHERE td.hotel_poi_id = ? AND td.trip_id = ?
       LIMIT 1`,
    )
    .bind(poiId, tripId, poiId, tripId)
    .first();
  return !!row;
}
