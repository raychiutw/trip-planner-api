/**
 * 帳號／開發者應用程式／行程成員權限／邀請 的 OpenAPI schema（OpenAPI 文件與契約測試共用同一份）。
 *
 * 命名風格在這組端點內並不一致，文件如實反映（不是筆誤）：
 * - 帳號 sessions／connected-apps／dev apps 走 OAuth 風格的 snake_case（handler 用 rawJson）。
 * - notifications／profile／stats／permissions／invitations 走 camelCase（handler 用 json 或自行 stringify）。
 */
import { z } from '@hono/zod-openapi';

// ───────── 共用 ─────────

/** `{ ok: true }` 之類的簡單確認。 */
export const Account_Ok = z.object({ ok: z.literal(true) }).openapi('Account_Ok');

// ───────── ai-authorization ─────────

export const Account_AiAuthorizationStatus = z.object({
  authorized: z.boolean().openapi({ description: '目前使用者是否已授權 Tripline AI（tp-request）代為編輯行程' }),
}).openapi('Account_AiAuthorizationStatus');

// ───────── connected-apps ─────────

export const Account_ConnectedApp = z.object({
  client_id: z.string(),
  app_name: z.string(),
  app_description: z.string().nullable(),
  app_logo_url: z.string().nullable(),
  homepage_url: z.string().nullable(),
  status: z.string().openapi({ description: 'client_apps.status，例如 active／pending_review／suspended' }),
  scopes: z.array(z.string()),
  granted_at: z.number().openapi({ description: '授權時間（epoch 毫秒）' }),
}).openapi('Account_ConnectedApp');

export const Account_ConnectedAppsList = z.object({ apps: z.array(Account_ConnectedApp) }).openapi('Account_ConnectedAppsList');

export const Account_ConnectedAppRevoked = z.object({
  ok: z.literal(true),
  revoked_client_id: z.string(),
}).openapi('Account_ConnectedAppRevoked');

// ───────── 帳號刪除 ─────────

export const Account_DeletePreview = z.object({
  hasPassword: z.boolean().openapi({ description: '有 local 密碼身分 → 刪除時必須帶 password；否則要走 Google 重新驗證 challenge' }),
  reauthProvider: z.enum(['google']).nullable().openapi({ description: '無密碼帳號可用的重新驗證 provider（目前只有 google）；有密碼或沒有 Google 身分時為 null（此時無法刪除，fail-closed）' }),
  reauthenticated: z.boolean().openapi({ description: 'web 呼叫者（tripline-web）：本 grant 有一個 verified、未過期、未使用的 web challenge 時為 true；其餘（含 mobile、有密碼帳號）恆為 false' }),
  tripsOwned: z.number().int(),
  collaboratorsAffected: z.number().int().openapi({ description: '這些行程上「不是自己」的 distinct 共編者人數' }),
}).openapi('Account_DeletePreview');

export const Account_DeleteBody = z.object({
  password: z.string().optional().openapi({ description: '帳號有 local 密碼身分時必填' }),
  confirm: z.literal('DELETE').optional().openapi({ description: '無密碼帳號的確認字串。mobile 必填；web（tripline-web）不需要（Google 重新驗證即確認，帶了也接受）。只帶它不夠，還要 challengeId' }),
  challengeId: z.string().optional().openapi({ description: '無密碼帳號必填：POST /api/account/delete-reauth 取得、且已 verified（同帳號、同 grant、同 client、同 surface〔web／mobile 不可互用〕、未過期）的 challenge；只能消耗一次。web 的完整 body 為 { "challengeId": "<id>" }' }),
}).openapi('Account_DeleteBody');

export const Account_DeleteResult = z.object({
  ok: z.literal(true),
  tripsDeleted: z.number().int(),
  auditRowsAnonymized: z.number().int(),
  // key 是被清除的資料表名稱（含 'audit_log(anonymized)' 這種帶註記的名稱），集合隨 schema 演進，沒有固定欄位。
  tablesCleared: z.record(z.string(), z.number().int()),
}).openapi('Account_DeleteResult');

// ───────── 帳號刪除的 Google 重新驗證 challenge（mobile 與 web）─────────

export const Account_DeleteReauthStarted = z.object({
  challengeId: z.string(),
  authorizeUrl: z.string().openapi({ description: '用瀏覽器開啟（導覽，不能帶 bearer）：/api/oauth/login/google?purpose=account-delete&challenge=<challengeId>；Google 驗證後 mobile 導回 mobile callback（?challenge_id=…&status=…），web 導回 ${WEB_ORIGIN}/account?deleteReauth=done|failed（固定網址，不收呼叫者傳入的網址）' }),
  expiresIn: z.literal(300).openapi({ description: 'challenge 與 Google 驗證的有效期（秒）；Google auth_time 也必須在這段時間內' }),
}).openapi('Account_DeleteReauthStarted', {
  example: {
    challengeId: 'ch_Zk3...（不透明字串）',
    authorizeUrl: 'https://api.example.com/api/oauth/login/google?purpose=account-delete&challenge=ch_Zk3...',
    expiresIn: 300,
  },
});

export const Account_DeleteReauthStatus = z.object({
  status: z.enum(['pending', 'started', 'verified', 'failed', 'cancelled', 'used', 'expired']).openapi({
    description: 'pending 剛建立 → started 已開始 Google 驗證 → verified 驗證成功（可刪帳號）→ used 已消耗；failed／cancelled 為終態；過期一律 expired',
  }),
  expiresIn: z.literal(0).optional().openapi({ description: '只在 expired 時出現（0）' }),
}).openapi('Account_DeleteReauthStatus', { example: { status: 'verified' } });

export const Account_DeleteReauthCancelled = z.object({
  status: z.enum(['cancelled', 'failed']).openapi({ description: 'cancelled：已取消；failed：驗證早已失敗，取消視為冪等的收尾（維持 failed）' }),
}).openapi('Account_DeleteReauthCancelled', { example: { status: 'cancelled' } });

export const Account_DeleteReauthQuery = z.object({
  challenge_id: z.string().openapi({ description: 'POST 回的 challengeId' }),
});

// ───────── notifications ─────────

export const Account_NotificationPreferences = z.object({
  tripUpdates: z.boolean(),
  invitations: z.boolean(),
  system: z.boolean(),
  updatedAt: z.string().nullable().openapi({ description: '尚未儲存過偏好時為 null（全部預設 true）' }),
}).openapi('Account_NotificationPreferences');

export const Account_NotificationPreferencesResponse = z.object({
  preferences: Account_NotificationPreferences,
}).openapi('Account_NotificationPreferencesResponse');

export const Account_NotificationPatchBody = z.object({
  tripUpdates: z.boolean().optional(),
  invitations: z.boolean().optional(),
  system: z.boolean().optional(),
}).openapi('Account_NotificationPatchBody', { description: '至少帶一個欄位；出現其他欄位名稱或非 boolean 值 → 400' });

// ───────── profile ─────────

export const Account_ProfilePatchBody = z.object({
  displayName: z.string().max(50).nullable().optional().openapi({
    description: 'trim 後寫入（最多 50 字）；null 或空字串＝清除；省略＝不更新（但整個 body 沒有可更新欄位會 400）',
  }),
}).openapi('Account_ProfilePatchBody');

export const Account_Profile = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.string(),
}).openapi('Account_Profile', { description: '形狀與 /api/oauth/userinfo 對齊' });

// ───────── sessions（以 OAuth grant 為單位） ─────────

export const Account_Session = z.object({
  sid: z.string().openapi({ description: 'OAuth grantId；DELETE /api/account/sessions/{sid} 用它撤銷' }),
  client_id: z.string(),
  ua_summary: z.string().openapi({ description: 'client 名稱（client_apps.app_name），查不到則為 client_id' }),
  ip_hash_prefix: z.null().openapi({ description: '恆為 null（oauth_models 不記錄 IP）；欄位保留是為了相容舊的 cookie session 形狀' }),
  created_at: z.string().openapi({ description: '該 grant 目前有效 token 的簽發時間（由到期時間回推），ISO 8601' }),
  last_seen_at: z.string().openapi({ description: '與 created_at 相同（oauth_models 沒有最後使用時間）' }),
  is_current: z.boolean().openapi({ description: '此請求所用的 access token 是否屬於該 grant' }),
}).openapi('Account_Session');

export const Account_SessionsList = z.object({
  current_sid: z.string().nullable().openapi({ description: '目前憑證的 grantId；查不到為 null' }),
  sessions: z.array(Account_Session).openapi({ description: '最多 100 筆，依簽發時間新到舊' }),
}).openapi('Account_SessionsList');

export const Account_SessionsRevokedOthers = z.object({
  ok: z.literal(true),
  revoked: z.number().int().openapi({ description: '被撤銷的 grant 數（不含目前這個）' }),
}).openapi('Account_SessionsRevokedOthers');

export const Account_SessionRevoked = z.object({
  ok: z.literal(true),
  revoked_sid: z.string(),
}).openapi('Account_SessionRevoked');

// ───────── stats ─────────

export const Account_Stats = z.object({
  tripCount: z.number().int(),
  totalDays: z.number().int(),
  collaboratorCount: z.number().int(),
}).openapi('Account_Stats', { description: 'service token（沒有 user）會得到三個 0，而不是 401' });

// ───────── dev apps ─────────

export const Account_DevAppCreateBody = z.object({
  app_name: z.string().min(2).max(80),
  redirect_uris: z.array(z.string()).min(1).max(10).openapi({ description: 'https only（localhost／127.0.0.1／[::1] 可 http）；不可含 #fragment、userinfo、?query' }),
  client_type: z.enum(['public', 'confidential']).optional().openapi({ description: '預設 public' }),
  app_description: z.string().max(500).optional(),
  homepage_url: z.string().optional().openapi({ description: 'https（localhost 可 http）；空字串視為未提供' }),
  allowed_scopes: z.array(z.enum(['openid', 'profile', 'email', 'offline_access'])).optional().openapi({
    description: '只允許這四個；省略或空陣列＝[openid, profile, email]。companion／ops:* 一律 400',
  }),
}).openapi('Account_DevAppCreateBody');

export const Account_DevAppCreated = z.object({
  client_id: z.string(),
  client_secret: z.string().nullable().openapi({ description: '只有 confidential 會有，且只在此回應出現一次；public 為 null' }),
  app_name: z.string(),
  client_type: z.enum(['public', 'confidential']),
  status: z.literal('pending_review'),
  redirect_uris: z.array(z.string()),
  allowed_scopes: z.array(z.string()),
}).openapi('Account_DevAppCreated');

/** 列表用：與明細相比**沒有** app_logo_url、owner 欄位。 */
export const Account_DevAppSummary = z.object({
  client_id: z.string(),
  client_type: z.string(),
  app_name: z.string(),
  app_description: z.string().nullable(),
  homepage_url: z.string().nullable(),
  redirect_uris: z.array(z.string()),
  allowed_scopes: z.array(z.string()),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('Account_DevAppSummary');

export const Account_DevAppList = z.object({ apps: z.array(Account_DevAppSummary) }).openapi('Account_DevAppList');

export const Account_DevApp = z.object({
  client_id: z.string(),
  client_type: z.string(),
  app_name: z.string(),
  app_description: z.string().nullable(),
  app_logo_url: z.string().nullable(),
  homepage_url: z.string().nullable(),
  redirect_uris: z.array(z.string()),
  allowed_scopes: z.array(z.string()),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('Account_DevApp');

export const Account_DevAppPatchBody = z.object({
  app_name: z.string().min(2).max(80).optional(),
  app_description: z.string().nullable().optional(),
  app_logo_url: z.string().nullable().optional().openapi({ description: 'https（localhost 可 http）；null／空字串＝清除' }),
  homepage_url: z.string().nullable().optional(),
  redirect_uris: z.array(z.string()).min(1).max(10).optional(),
  allowed_scopes: z.array(z.enum(['openid', 'profile', 'email', 'offline_access'])).min(1).optional(),
}).openapi('Account_DevAppPatchBody', { description: '至少一個欄位；不能改 client_id／client_type／status／owner' });

export const Account_DevAppSuspended = z.object({
  ok: z.literal(true),
  suspended_client_id: z.string(),
}).openapi('Account_DevAppSuspended', { description: '軟刪除：status 改為 suspended，資料保留' });

// ───────── permissions ─────────

export const Account_PermissionRole = z.enum(['member', 'viewer']).openapi('Account_PermissionRole');

export const Account_PermissionRow = z.object({
  id: z.number().int().openapi({ description: 'trip_permissions 主鍵；PATCH／DELETE /api/permissions/{id} 用它' }),
  email: z.string().nullable().openapi({ description: 'LEFT JOIN users；使用者列遺失時為 null' }),
  displayName: z.string().nullable(),
  tripId: z.string(),
  role: z.string().openapi({ description: 'owner／member／viewer' }),
  userId: z.string().nullable(),
}).openapi('Account_PermissionRow');

export const Account_PermissionList = z.array(Account_PermissionRow).openapi('Account_PermissionList', {
  description: '直接是陣列（不是包在物件裡），依 email 排序',
});

export const Account_PermissionCreateBody = z.object({
  email: z.string().openapi({ description: '被邀請者 email；格式不符 → 400' }),
  tripId: z.string(),
  role: Account_PermissionRole.optional().openapi({ description: '預設 member；owner 不能經邀請授予' }),
}).openapi('Account_PermissionCreateBody');

/**
 * 兩個分支都回 201 且 status 恆為 'invitation_sent'（刻意讓「email 是否已註冊」從回應看不出來）：
 * - email 已註冊且已驗證 → 直接加入，回 `id`（trip_permissions 主鍵）。
 * - 其他 → 建立邀請 token，回 `expiresAt`。
 * 兩個欄位互斥，所以用 union。
 */
export const Account_PermissionCreated = z.union([
  z.object({ ok: z.literal(true), status: z.literal('invitation_sent'), email: z.string(), id: z.number().int() }),
  z.object({ ok: z.literal(true), status: z.literal('invitation_sent'), email: z.string(), expiresAt: z.string() }),
]).openapi('Account_PermissionCreated');

export const Account_PermissionPatchBody = z.object({
  role: Account_PermissionRole,
}).openapi('Account_PermissionPatchBody');

export const Account_PermissionUpdated = z.union([
  z.object({ ok: z.literal(true), unchanged: z.literal(true) }),
  z.object({ ok: z.literal(true), role: Account_PermissionRole }),
]).openapi('Account_PermissionUpdated', { description: '角色沒變 → { ok, unchanged: true }；有變 → { ok, role }' });

// ───────── invitations ─────────

export const Account_InvitationPreview = z.object({
  tripId: z.string(),
  tripTitle: z.string(),
  invitedEmail: z.string(),
  role: z.enum(['member', 'viewer']),
  inviterDisplayName: z.string().nullable(),
  inviterEmail: z.string(),
  expiresAt: z.string(),
}).openapi('Account_InvitationPreview');

export const Account_PendingInvitation = z.object({
  id: z.string().openapi({ description: 'token_hash（不是原始 token）；僅作列表的穩定識別，撤銷請用 POST /api/invitations/revoke（tripId＋email）' }),
  invitedEmail: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  daysRemaining: z.number().int(),
  isExpired: z.boolean(),
}).openapi('Account_PendingInvitation');

export const Account_PendingInvitationList = z.object({
  items: z.array(Account_PendingInvitation).openapi({ description: '最多 100 筆，新到舊；包含已過期但未接受的' }),
}).openapi('Account_PendingInvitationList');

export const Account_InvitationsQuery = z.object({
  token: z.string().optional().openapi({ description: '公開預覽（不需登入）。與 tripId 同時出現時以 tripId 為準' }),
  tripId: z.string().optional().openapi({ description: '列出該行程 pending 邀請（需登入且為行程擁有者）' }),
});

export const Account_InvitationAcceptBody = z.object({
  token: z.string().openapi({ description: '邀請信中的原始 token' }),
}).openapi('Account_InvitationAcceptBody');

export const Account_InvitationAccepted = z.object({
  ok: z.literal(true),
  tripId: z.string(),
  tripTitle: z.string(),
}).openapi('Account_InvitationAccepted');

export const Account_InvitationRevokeBody = z.object({
  tripId: z.string(),
  email: z.string(),
}).openapi('Account_InvitationRevokeBody');

export const Account_InvitationRevoked = z.object({
  ok: z.literal(true),
  revoked: z.number().int(),
}).openapi('Account_InvitationRevoked');

export const Account_PermissionsQuery = z.object({ tripId: z.string().openapi({ description: '必填；缺少 → 400' }) });

/** GET /api/invitations 依參數回兩種形狀：?tripId= → { items }；?token= → 預覽。 */
export const Account_InvitationsGetResponse = z.union([Account_PendingInvitationList, Account_InvitationPreview]).openapi('Account_InvitationsGetResponse');
