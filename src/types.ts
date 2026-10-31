/**
 * api 的共用型別：錯誤碼、錯誤訊息、認證資料。
 * 從舊入口（trip-planner 的 src/types/api.ts）原樣搬來，契約要與 web 一致；之後以 OpenAPI 為單一來源。
 */

export const ErrorCode = {
  // 網路（前端產生）
  NET_TIMEOUT: 'NET_TIMEOUT',
  NET_OFFLINE: 'NET_OFFLINE',
  // 認證
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  // 權限
  PERM_DENIED: 'PERM_DENIED',
  PERM_ADMIN_ONLY: 'PERM_ADMIN_ONLY',
  PERM_NOT_OWNER: 'PERM_NOT_OWNER',
  // 資料
  DATA_NOT_FOUND: 'DATA_NOT_FOUND',
  DATA_VALIDATION: 'DATA_VALIDATION',
  DATA_CONFLICT: 'DATA_CONFLICT',
  DATA_ENCODING: 'DATA_ENCODING',
  DATA_SAVE_FAILED: 'DATA_SAVE_FAILED',
  // 系統
  SYS_INTERNAL: 'SYS_INTERNAL',
  SYS_DB_ERROR: 'SYS_DB_ERROR',
  SYS_RATE_LIMIT: 'SYS_RATE_LIMIT',
  // 2xx 但非 JSON（Cloudflare edge 限流/挑戰頁、路由異常回 SPA、proxy 錯誤頁）——
  // 上游未真正回應，成因不必然是 user 操作過頻，故與 SYS_RATE_LIMIT 分離，避免誤導
  // telemetry 分桶與 user copy。
  SYS_UPSTREAM_UNAVAILABLE: 'SYS_UPSTREAM_UNAVAILABLE',
  // Companion path（poi-favorites-rename §4 / §6.3）
  // companion_request_actions UNIQUE 衝突 → 同 requestId 同 action 重複呼叫
  COMPANION_QUOTA_EXCEEDED: 'COMPANION_QUOTA_EXCEEDED',
  // Google Maps Platform (v2.23.0 google-maps-migration)
  MAPS_LOCKED: 'MAPS_LOCKED',
  MAPS_UPSTREAM_FAILED: 'MAPS_UPSTREAM_FAILED',
  // v2.33.58 round 12 I5: distinct from UPSTREAM_FAILED — config error not transient
  MAPS_CONFIG: 'MAPS_CONFIG',
  // Multi-POI per entry (v2.27.0)
  STALE_ENTRY: 'STALE_ENTRY',
  DUPLICATE_POI: 'DUPLICATE_POI',
  POI_NOT_ALTERNATE: 'POI_NOT_ALTERNATE',
  MISSING_MASTER: 'MISSING_MASTER',
  INVALID_ORDER: 'INVALID_ORDER',
  // AI 健檢 guard (v2.31.58)
  TRIP_EMPTY: 'TRIP_EMPTY',
  // Trip invitations lifecycle（被邀請者點 link 收到的 410 GONE）
  INVITATION_TOKEN_MISSING: 'INVITATION_TOKEN_MISSING',
  INVITATION_INVALID: 'INVITATION_INVALID',
  INVITATION_ACCEPTED: 'INVITATION_ACCEPTED',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  SERVER_MISCONFIG: 'SERVER_MISCONFIG',
  // Tripline auth flow（login / signup / reset-password）—— 對 frontend 提供穩定 code
  LOGIN_INVALID_INPUT: 'LOGIN_INVALID_INPUT',
  LOGIN_INVALID: 'LOGIN_INVALID',
  LOGIN_RATE_LIMITED: 'LOGIN_RATE_LIMITED',
  SIGNUP_INVALID_EMAIL: 'SIGNUP_INVALID_EMAIL',
  SIGNUP_PASSWORD_TOO_SHORT: 'SIGNUP_PASSWORD_TOO_SHORT',
  SIGNUP_PASSWORD_FORMAT: 'SIGNUP_PASSWORD_FORMAT',
  SIGNUP_EMAIL_TAKEN: 'SIGNUP_EMAIL_TAKEN',
  SIGNUP_RATE_LIMITED: 'SIGNUP_RATE_LIMITED',
  RESET_TOKEN_MISSING: 'RESET_TOKEN_MISSING',
  RESET_PASSWORD_TOO_SHORT: 'RESET_PASSWORD_TOO_SHORT',
  RESET_TOKEN_INVALID: 'RESET_TOKEN_INVALID',
  RESET_PASSWORD_FORMAT: 'RESET_PASSWORD_FORMAT',
  RESET_RATE_LIMITED: 'RESET_RATE_LIMITED',
  // 帳號刪除（不可逆，需二次確認）
  ACCOUNT_DELETE_CONFIRM_REQUIRED: 'ACCOUNT_DELETE_CONFIRM_REQUIRED',
  ACCOUNT_DELETE_PASSWORD_INVALID: 'ACCOUNT_DELETE_PASSWORD_INVALID',
  SIGNUP_CONSENT_REQUIRED: 'SIGNUP_CONSENT_REQUIRED',
  NOTES_AI_INVALID_OUTPUT: 'NOTES_AI_INVALID_OUTPUT',
  NOTES_AI_NO_VALID_ITEMS: 'NOTES_AI_NO_VALID_ITEMS',
  NOTES_AI_JOB_STALE: 'NOTES_AI_JOB_STALE',
  NOTES_AI_NOT_REASSIGNABLE: 'NOTES_AI_NOT_REASSIGNABLE',
  NOTES_AI_APPLY_FAILED: 'NOTES_AI_APPLY_FAILED',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

export const ERROR_MESSAGES: Record<ErrorCodeType, string> = {
  NET_TIMEOUT: '連線逾時，請檢查網路',
  NET_OFFLINE: '目前離線，顯示快取資料',
  AUTH_REQUIRED: '請先登入',
  AUTH_EXPIRED: '登入已過期，請重新登入',
  AUTH_INVALID: '認證失敗，請重新登入',
  PERM_DENIED: '你沒有此操作的權限',
  PERM_ADMIN_ONLY: '僅管理員可操作',
  PERM_NOT_OWNER: '這不是你的行程',
  DATA_NOT_FOUND: '找不到這筆資料',
  DATA_VALIDATION: '資料格式不正確',
  DATA_CONFLICT: '這筆資料已經存在',
  DATA_ENCODING: '文字編碼有誤，請用 UTF-8',
  DATA_SAVE_FAILED: '儲存失敗，請再試一次',
  SYS_INTERNAL: '系統發生錯誤，已通知開發團隊',
  SYS_DB_ERROR: '資料庫忙碌中，請稍後再試',
  SYS_RATE_LIMIT: '操作太頻繁，請稍等',
  SYS_UPSTREAM_UNAVAILABLE: '伺服器暫時無法回應，請稍後重試',
  COMPANION_QUOTA_EXCEEDED: '此請求已執行過此操作',
  MAPS_LOCKED: '本月 Google API 已達配額，月初恢復',
  MAPS_UPSTREAM_FAILED: 'Google Maps 服務暫時無法回應，請稍後再試',
  MAPS_CONFIG: 'Google Maps API 設定錯誤，請聯絡管理員',
  STALE_ENTRY: '資料已被其他操作更新，請重新整理',
  DUPLICATE_POI: '此景點已存在於這個停留點',
  POI_NOT_ALTERNATE: '此景點不是這個停留點的備選',
  MISSING_MASTER: '每個停留點必須有一個正選景點',
  INVALID_ORDER: '備選排序格式不正確',
  TRIP_EMPTY: '此行程尚無景點，請先加入景點再執行健檢',
  INVITATION_TOKEN_MISSING: '邀請連結缺少 token 參數',
  INVITATION_INVALID: '邀請連結無效，請聯絡邀請者重寄',
  INVITATION_ACCEPTED: '此邀請已接受過，請直接登入',
  INVITATION_EXPIRED: '邀請已過期，請聯絡邀請者重寄',
  SERVER_MISCONFIG: '伺服器設定錯誤，請聯絡管理員',
  LOGIN_INVALID_INPUT: 'email + password 必填',
  LOGIN_INVALID: 'email 或密碼錯誤',
  LOGIN_RATE_LIMITED: '登入嘗試過多，請稍後再試',
  SIGNUP_INVALID_EMAIL: 'Email 格式無效',
  SIGNUP_PASSWORD_TOO_SHORT: '密碼長度不足',
  SIGNUP_PASSWORD_FORMAT: '密碼格式不符',
  SIGNUP_EMAIL_TAKEN: '此 email 已註冊，請改用登入或忘記密碼',
  SIGNUP_RATE_LIMITED: '註冊嘗試過多，請稍後再試',
  RESET_TOKEN_MISSING: '缺少 token',
  RESET_PASSWORD_TOO_SHORT: '密碼長度不足',
  RESET_TOKEN_INVALID: '重設連結已過期或無效',
  RESET_PASSWORD_FORMAT: '密碼格式不符',
  RESET_RATE_LIMITED: '密碼重設嘗試過多，請稍後再試',
  ACCOUNT_DELETE_CONFIRM_REQUIRED: '刪除帳號需要二次確認',
  ACCOUNT_DELETE_PASSWORD_INVALID: '密碼不正確，帳號未刪除',
  SIGNUP_CONSENT_REQUIRED: '請先閱讀並同意個資條款',
  NOTES_AI_INVALID_OUTPUT: 'AI 回傳格式不正確，未變更原有內容',
  NOTES_AI_NO_VALID_ITEMS: 'AI 沒有回傳可用項目，未變更原有內容',
  NOTES_AI_JOB_STALE: '這次生成已逾時，請重新生成',
  NOTES_AI_NOT_REASSIGNABLE: '只有原本由 AI 產生的項目可交還 AI 維護',
  NOTES_AI_APPLY_FAILED: '套用 AI 內容失敗，未變更原有內容',
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Authentication data attached to every request by _middleware.ts.
 * Stored on context.data.auth and passed through to API handlers.
 *
 * V2 cutover (migration 0046+0047): userId is the canonical identifier.
 * email is retained for audit_log changedBy + display + dual-read fallback
 * during the email→user_id transition. After phase 2 (DROP email columns),
 * email becomes derived (JOIN users.email by id) for those use cases.
 */

export interface AuthData {
  /** Email — kept for audit_log changedBy + display. May fall back when userId is null. */
  email: string;
  /** V2 user_id (TEXT uuid). null only for service-token / pre-V2 sessions. */
  userId: string | null;
  isServiceToken: boolean;
  /** OAuth scopes from V2 Bearer token (client_credentials grant). Only present for service token. */
  scopes?: string[];
  /** OAuth client_id from V2 Bearer token. Only present for service token. */
  clientId?: string;
  /**
   * Trip-scoped token restriction (v2.55.56, tp-request downscope). When set, the
   * token may ONLY read/write this one trip — hasWritePermission / requireTripReadAccess
   * deny any other tripId. Issued by /api/oauth/downscope so the automated tp-request
   * agent, even if prompt-injected, physically cannot touch trips other than the one
   * its current request belongs to. Undefined for normal (unrestricted) tokens.
   */
  restrictTrip?: string;
  /**
   * 這個 Bearer token 是否來自**第一方** client（自家 tp-request AI pipeline）。
   * 由 middleware 依 `clientId === env.TP_REQUEST_CLIENT_ID` 判定 —— 判斷放在
   * middleware 是因為只有那裡拿得到 env。
   *
   * 用途：OAuth scope gate（_auth.ts `hasTripScope`）豁免第一方 client。
   * 它的授權來自 Consent + restrict_trip 機制而**非 scopes** ——
   * `ai-authorization.ts` 的 Consent 只存 openid/profile，見該檔 authz-drift 警語。
   * 不豁免的話，downscope（尚未取得 restrictTrip 的那一步）會被擋，整條 AI pipeline 斷掉。
   */
  isFirstPartyClient?: boolean;
}
