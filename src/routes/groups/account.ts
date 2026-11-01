import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as S from '../../schemas/account';
import { onRequestGet as accountAiAuthorizationGet, onRequestPost as accountAiAuthorizationPost } from '../handlers/account/ai-authorization';
import { onRequestGet as accountConnectedAppsGet } from '../handlers/account/connected-apps';
import { onRequestDelete as accountConnectedAppsClientIdDelete } from '../handlers/account/connected-apps/@client_id';
import { onRequestPost as accountDeleteReauthPost, onRequestGet as accountDeleteReauthGet, onRequestDelete as accountDeleteReauthDelete } from '../handlers/account/delete-reauth';
import { onRequestGet as accountIndexGet, onRequestDelete as accountIndexDelete } from '../handlers/account/index';
import { onRequestGet as accountNotificationsGet, onRequestPatch as accountNotificationsPatch } from '../handlers/account/notifications';
import { onRequestPatch as accountProfilePatch } from '../handlers/account/profile';
import { onRequestGet as accountSessionsGet, onRequestDelete as accountSessionsDelete } from '../handlers/account/sessions';
import { onRequestDelete as accountSessionsSidDelete } from '../handlers/account/sessions/@sid';
import { onRequestGet as accountStatsGet } from '../handlers/account/stats';
import { onRequestPost as devAppsPost, onRequestGet as devAppsGet } from '../handlers/dev/apps';
import { onRequestGet as devAppsClientIdGet, onRequestPatch as devAppsClientIdPatch, onRequestDelete as devAppsClientIdDelete } from '../handlers/dev/apps/@client_id';
import { onRequestGet as permissionsGet, onRequestPost as permissionsPost } from '../handlers/permissions';
import { onRequestDelete as permissionsIdDelete, onRequestPatch as permissionsIdPatch } from '../handlers/permissions/@id';
import { onRequestGet as invitationsGet } from '../handlers/invitations';
import { onRequestPost as invitationsAcceptPost } from '../handlers/invitations/accept';
import { onRequestPost as invitationsRevokePost } from '../handlers/invitations/revoke';

/**
 * 帳號／權限／邀請／開發者應用程式。
 * 除 GET /api/invitations 外一律 required。GET /api/invitations 的 `?token=` 分支舊入口是公開的
 * （InvitePage 給未登入者預覽），`?tripId=` 分支由 handler 內 requireAuth 把關，所以用 optional。
 */
const err = (description: string) => ({ description, schema: ApiError });
const E401 = err('未登入、token 無效或已過期（code: AUTH_REQUIRED）');
/** requireAccountUser 的 403：第三方（非第一方）client 的 token，或 trip 範圍的受限 token。 */
const E403_ACCOUNT = err('token 屬於非第一方的 client，或是 trip 範圍的受限 token（code: PERM_DENIED）');
/** ensureCanManageTripPerms 的 403／404（permissions／invitations 共用）。 */
const E403_OWNER = err('不是該行程的擁有者（PERM_ADMIN_ONLY；service token 也是此碼；訊息文字提到「管理者」但全域 admin 已移除），或是受限 token（PERM_DENIED）');
const E404_TRIP = err('找不到該行程（DATA_NOT_FOUND）');
const E400 = (what: string) => err(`${what}（code: DATA_VALIDATION）`);

/**
 * 帳號／權限／邀請／開發者應用程式。
 * 除 GET /api/invitations 外一律 required。GET /api/invitations 的 `?token=` 分支舊入口是公開的
 * （InvitePage 給未登入者預覽），`?tripId=` 分支由 handler 內 requireAuth 把關，所以用 optional。
 *
 * 帳號類端點（account／dev apps／invitations accept）用 requireAccountUser：只收第一方 client 簽發的
 * user-bound、非受限 token，所以都可能回 403 PERM_DENIED。
 */
export function registerAccountRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, {
    method: 'get', path: '/api/account/ai-authorization', auth: 'required', handler: accountAiAuthorizationGet, summary: 'AI 授權狀態',
    docs: { responses: { 200: { description: '是否已授權', schema: S.Account_AiAuthorizationStatus }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/account/ai-authorization', auth: 'required', handler: accountAiAuthorizationPost, summary: '授權 Tripline AI',
    docs: { responses: { 200: { description: '建立（或更新）授權；idempotent，永遠回 authorized: true', schema: S.Account_AiAuthorizationStatus }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/account/connected-apps', auth: 'required', handler: accountConnectedAppsGet, summary: '已連線的應用程式',
    docs: { responses: { 200: { description: '使用者授權過的應用程式（snake_case）', schema: S.Account_ConnectedAppsList }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/account/connected-apps/:client_id', auth: 'required', handler: accountConnectedAppsClientIdDelete, summary: '撤銷應用程式授權',
    docs: { responses: {
      200: { description: '授權與該 client 的 access／refresh token 已一併刪除', schema: S.Account_ConnectedAppRevoked },
      401: E401, 403: E403_ACCOUNT,
      404: err('使用者沒有授權過此 client（code: CONSENT_NOT_FOUND）'),
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/account', auth: 'required', handler: accountIndexGet, summary: '帳號刪除預覽',
    docs: { responses: { 200: { description: '刪除前的影響預覽（確認對話框用；含無密碼帳號可用的 reauthProvider）', schema: S.Account_DeletePreview }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/account', auth: 'required', handler: accountIndexDelete, summary: '刪除帳號（不可逆）',
    docs: {
      body: S.Account_DeleteBody,
      responses: {
        200: { description: '帳號與所擁有的行程（含共編者的）已抹除；所有 token／授權一併清除', schema: S.Account_DeleteResult },
        400: err('沒帶二次確認：有密碼的帳號沒給 password，或無密碼帳號的 confirm 不是 "DELETE"（code: ACCOUNT_DELETE_CONFIRM_REQUIRED）'),
        401: err('未登入（AUTH_REQUIRED），或密碼錯誤且資料未動（ACCOUNT_DELETE_PASSWORD_INVALID）'),
        403: err('token 屬於非第一方 client 或受限 token（PERM_DENIED）；或無密碼帳號沒有「verified、同帳號、同 grant、未過期、與環境相符 client」的 challenge（ACCOUNT_DELETE_REAUTH_REQUIRED，fail-closed，資料未動）'),
      },
    },
  });
  const E403_MOBILE = err('不是與環境相符的 mobile client 簽發、綁 grant 的 user token（PERM_DENIED）');
  legacyRoute(app, {
    method: 'post', path: '/api/account/delete-reauth', auth: 'required', handler: accountDeleteReauthPost, summary: '建立帳號刪除的 Google 重新驗證 challenge',
    docs: { responses: {
      200: { description: '已建立 challenge（5 分鐘有效，Cache-Control: no-store）。用瀏覽器開 authorizeUrl 完成 Google 驗證後，callback 會 302 回 mobile callback ?challenge_id=…&status=verified（失敗為 status=failed）', schema: S.Account_DeleteReauthStarted },
      401: E401,
      403: err('不是與環境相符的 mobile client 簽發、綁 grant 的 user token（PERM_DENIED）；或此帳號沒有 Google 身分（ACCOUNT_DELETE_REAUTH_REQUIRED）'),
      500: err('MOBILE_OAUTH_CALLBACK_URL 未設定、無效，或與環境契約不符（SERVER_MISCONFIG）'),
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/account/delete-reauth', auth: 'required', handler: accountDeleteReauthGet, summary: '查 challenge 狀態',
    docs: { query: S.Account_DeleteReauthQuery, responses: {
      200: { description: 'challenge 狀態（Cache-Control: no-store）；過期為 expired', schema: S.Account_DeleteReauthStatus },
      400: E400('沒帶 challenge_id'),
      401: E401, 403: E403_MOBILE,
      404: err('challenge 不存在，或不屬於這個使用者／grant／client；一律同一個回應（DATA_NOT_FOUND）'),
    } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/account/delete-reauth', auth: 'required', handler: accountDeleteReauthDelete, summary: '取消 challenge',
    docs: { query: S.Account_DeleteReauthQuery, responses: {
      200: { description: 'pending／started／verified 轉為 cancelled；cancelled 重複取消維持 cancelled；failed 冪等維持 failed', schema: S.Account_DeleteReauthCancelled },
      400: E400('沒帶 challenge_id'),
      401: E401,
      403: err('不是 mobile client 的 token（PERM_DENIED）；或 challenge 已過期（ACCOUNT_DELETE_REAUTH_REQUIRED）'),
      404: err('challenge 不存在，或不屬於這個使用者／grant／client（DATA_NOT_FOUND）'),
      409: err('challenge 已 used（已用來刪帳號），或取消時狀態剛被並行請求改變（DATA_CONFLICT）'),
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/account/notifications', auth: 'required', handler: accountNotificationsGet, summary: '通知偏好',
    docs: { responses: { 200: { description: '目前偏好；未儲存過則全部 true、updatedAt 為 null', schema: S.Account_NotificationPreferencesResponse }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/account/notifications', auth: 'required', handler: accountNotificationsPatch, summary: '更新通知偏好',
    docs: { body: S.Account_NotificationPatchBody, responses: {
      200: { description: '更新後的完整偏好', schema: S.Account_NotificationPreferencesResponse },
      400: E400('body 不是 JSON object、含未知欄位、值不是 boolean，或一個欄位都沒帶'),
      401: E401, 403: E403_ACCOUNT,
    } },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/account/profile', auth: 'required', handler: accountProfilePatch, summary: '更新個人資料',
    docs: { body: S.Account_ProfilePatchBody, responses: {
      200: { description: '更新後的使用者資料（與 userinfo 同形狀）', schema: S.Account_Profile },
      400: E400('displayName 型別錯誤、超過 50 字，或沒有可更新的欄位'),
      401: E401,
      403: err('trip 範圍的受限 token 不可改帳號資料（code: PERM_DENIED）'),
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/account/sessions', auth: 'required', handler: accountSessionsGet, summary: '有效連線（OAuth grant）',
    docs: { responses: { 200: { description: '以 OAuth grant 為單位的有效連線；sid 即 grantId，ip_hash_prefix 恆為 null', schema: S.Account_SessionsList }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/account/sessions', auth: 'required', handler: accountSessionsDelete, summary: '撤銷其他所有連線',
    docs: { responses: { 200: { description: '已撤銷除目前這個以外的所有 grant', schema: S.Account_SessionsRevokedOthers }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/account/sessions/:sid', auth: 'required', handler: accountSessionsSidDelete, summary: '撤銷指定連線',
    docs: { responses: {
      200: { description: '該 grant 的 access／refresh token 已刪除（撤銷自己目前的連線也允許，等同登出）', schema: S.Account_SessionRevoked },
      401: E401, 403: E403_ACCOUNT,
      404: err('grantId 不存在、已撤銷或不屬於自己；一律同一個回應，不洩漏存在與否（code: SESSION_NOT_FOUND）'),
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/account/stats', auth: 'required', handler: accountStatsGet, summary: '帳號統計',
    docs: { responses: { 200: { description: '行程數、總天數、共編者人數（service token 沒有 user，三項皆 0）', schema: S.Account_Stats }, 401: E401 } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/dev/apps', auth: 'required', handler: devAppsPost, summary: '註冊開發者應用程式',
    docs: { body: S.Account_DevAppCreateBody, responses: {
      201: { description: '已建立，狀態為 pending_review；client_secret 只在這裡出現一次', schema: S.Account_DevAppCreated },
      400: E400('名稱長度、client_type、redirect_uris、scope 白名單、homepage_url 或描述長度不符規則'),
      401: E401, 403: E403_ACCOUNT,
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/dev/apps', auth: 'required', handler: devAppsGet, summary: '我的開發者應用程式',
    docs: { responses: { 200: { description: '自己擁有的應用程式（不含 secret hash；不含 app_logo_url），新到舊', schema: S.Account_DevAppList }, 401: E401, 403: E403_ACCOUNT } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/dev/apps/:client_id', auth: 'required', handler: devAppsClientIdGet, summary: '開發者應用程式明細',
    docs: { responses: { 200: { description: '應用程式明細', schema: S.Account_DevApp }, 401: E401, 403: E403_ACCOUNT, 404: err('不存在或不是自己的（兩者無法區分）（code: APP_NOT_FOUND）') } },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/dev/apps/:client_id', auth: 'required', handler: devAppsClientIdPatch, summary: '更新開發者應用程式',
    docs: { body: S.Account_DevAppPatchBody, responses: {
      200: { description: '更新後的明細', schema: S.Account_DevApp },
      400: E400('欄位不符規則（同 POST），或一個可更新欄位都沒帶'),
      401: E401, 403: E403_ACCOUNT,
      404: err('不存在或不是自己的（code: APP_NOT_FOUND）'),
    } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/dev/apps/:client_id', auth: 'required', handler: devAppsClientIdDelete, summary: '停用開發者應用程式',
    docs: { responses: { 200: { description: '軟刪除（status 改為 suspended）', schema: S.Account_DevAppSuspended }, 401: E401, 403: E403_ACCOUNT, 404: err('不存在或不是自己的（code: APP_NOT_FOUND）') } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/permissions', auth: 'required', handler: permissionsGet, summary: '行程成員權限',
    docs: { query: S.Account_PermissionsQuery, responses: {
      200: { description: '該行程所有成員（直接是陣列，camelCase）', schema: S.Account_PermissionList },
      400: E400('缺少 tripId'),
      401: E401, 403: E403_OWNER, 404: E404_TRIP,
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/permissions', auth: 'required', handler: permissionsPost, summary: '邀請成員',
    docs: { body: S.Account_PermissionCreateBody, responses: {
      201: { description: 'status 恆為 invitation_sent（不洩漏 email 是否已註冊）；已註冊且已驗證者直接加入並回 id，其餘建立邀請並回 expiresAt。寄信失敗不影響結果', schema: S.Account_PermissionCreated },
      400: E400('缺 email／tripId、role 不是 member／viewer，或 email 格式不正確'),
      401: E401, 403: E403_OWNER, 404: E404_TRIP,
      409: err('此 email 已有此行程的權限，或已有 pending 邀請（code: DATA_CONFLICT）'),
      500: err('伺服器沒有設定 SESSION_SECRET，無法簽發邀請 token（code: SYS_INTERNAL；5xx 不帶 detail）'),
    } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/permissions/:id', auth: 'required', handler: permissionsIdDelete, summary: '移除成員',
    docs: { responses: {
      200: { description: '已移除', schema: S.Account_Ok },
      401: E401,
      403: err('呼叫者是該行程擁有者，但目標是擁有者列（PERM_DENIED，不可移除擁有者）'),
      404: err('找不到該權限記錄，**或呼叫者沒有該行程的管理權**（非成員、一般成員、別的行程的擁有者、受限 token），一律同一個 404（DATA_NOT_FOUND），刻意不洩漏 id 是否存在、是不是擁有者列'),
    } },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/permissions/:id', auth: 'required', handler: permissionsIdPatch, summary: '變更成員角色',
    docs: { body: S.Account_PermissionPatchBody, responses: {
      200: { description: '角色沒變回 { ok, unchanged: true }，有變回 { ok, role }', schema: S.Account_PermissionUpdated },
      400: E400('role 不是 member／viewer'),
      401: E401,
      403: err('呼叫者是該行程擁有者，但目標是擁有者列（PERM_DENIED，不可改擁有者的角色）'),
      404: err('找不到該權限記錄，**或呼叫者沒有該行程的管理權**（非成員、一般成員、別的行程的擁有者、受限 token），一律同一個 404（DATA_NOT_FOUND），刻意不洩漏 id 是否存在、是不是擁有者列'),
    } },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/invitations', auth: 'optional', handler: invitationsGet, summary: '邀請預覽／待處理邀請',
    docs: { query: S.Account_InvitationsQuery, responses: {
      200: { description: '?tripId= → { items }（pending 邀請列表）；?token= → 邀請預覽。兩者都帶時以 tripId 為準', schema: S.Account_InvitationsGetResponse },
      400: err('兩個參數都沒帶（code: INVITATION_TOKEN_MISSING）'),
      401: E401,
      403: err('?tripId= 分支：不是該行程擁有者（PERM_ADMIN_ONLY）或是受限 token（PERM_DENIED）'),
      404: err('?tripId= 分支：找不到該行程（code: DATA_NOT_FOUND）'),
      410: err('?token= 分支：token 無效（INVITATION_INVALID）、已過期（INVITATION_EXPIRED）或已被接受（INVITATION_ACCEPTED）；用 410 而不是 404，因為「已失效」是邀請的正常結局'),
      500: err('?token= 分支：伺服器沒有設定 SESSION_SECRET（code: SERVER_MISCONFIG）'),
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/invitations/accept', auth: 'required', handler: invitationsAcceptPost, summary: '接受邀請',
    docs: { body: S.Account_InvitationAcceptBody, responses: {
      200: { description: '已加入行程', schema: S.Account_InvitationAccepted },
      400: err('缺少 token（code: INVITATION_TOKEN_MISSING）'),
      401: E401,
      403: err('邀請不屬於目前登入的 email（INVITATION_EMAIL_MISMATCH），或 token 屬於非第一方 client／受限 token（PERM_DENIED）'),
      410: err('邀請無效（INVITATION_INVALID）、已過期（INVITATION_EXPIRED）或已被接受（INVITATION_ACCEPTED）'),
      500: err('伺服器沒有設定 SESSION_SECRET（code: SERVER_MISCONFIG）'),
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/invitations/revoke', auth: 'required', handler: invitationsRevokePost, summary: '撤銷邀請',
    docs: { body: S.Account_InvitationRevokeBody, responses: {
      200: { description: '已刪除 pending 邀請（已接受的邀請不能撤銷，要改走 DELETE /api/permissions/{id}）', schema: S.Account_InvitationRevoked },
      400: err('缺 tripId 或 email（code: INVITATION_REVOKE_VALIDATION）'),
      401: E401, 403: E403_OWNER,
      404: err('找不到行程（DATA_NOT_FOUND），或該 email 沒有 pending 邀請（INVITATION_NOT_FOUND）'),
    } },
  });
}
