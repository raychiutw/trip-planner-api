/** signup 組（註冊／驗證／忘記密碼／分享）的 OpenAPI schema；契約測試與路由文件共用同一份。 */
import { z } from '@hono/zod-openapi';

/* ───────── 註冊與帳號驗證 ───────── */

export const Signup_SignupBody = z.object({
  email: z.string().openapi({ description: '會 trim + 轉小寫；需符合 email 格式', example: 'a@example.com' }),
  password: z.string().min(8).openapi({ description: '長度下限以 handler 的 MIN_PASSWORD_LEN 為準（執行期檢查）' }),
  privacyConsent: z.literal(true).openapi({ description: '必須是布林 true；缺欄位、false、字串都視為未同意' }),
  displayName: z.string().optional(),
  invitationToken: z.string().optional().openapi({ description: '共編邀請 token；註冊成功後 best-effort 接受邀請，失敗不擋註冊' }),
}).openapi('Signup_SignupBody');

/** 成功回應刻意**不含任何 session／token 欄位**：註冊後不發登入憑證，請另走 POST /api/oauth/login。 */
export const Signup_SignupResult = z.object({
  ok: z.literal(true),
  userId: z.string(),
  email: z.string(),
  requiresVerification: z.literal(true),
  joinedTrip: z.object({ id: z.string(), title: z.string() }).nullable(),
  invitationError: z.string().nullable().openapi({ description: '邀請接受失敗時的錯誤碼，例如 INVITATION_ACCEPT_FAILED' }),
}).openapi('Signup_SignupResult');

export const Signup_VerifyBody = z.object({ token: z.string() }).openapi('Signup_VerifyBody');
export const Signup_OkOnly = z.object({ ok: z.literal(true) }).openapi('Signup_OkOnly');

/** verify 端點的錯誤是**扁平字串**（不是巢狀 ApiError）。 */
export const Signup_VerifyError = z.object({
  error: z.enum(['missing_token', 'expired', 'used', 'server_error']),
}).openapi('Signup_VerifyError');

export const Signup_EmailBody = z.object({ email: z.string().optional() }).openapi('Signup_EmailBody');

/** send-verification／forgot-password 的成功回應：對任何 email 形狀完全一致（防帳號列舉）。 */
export const Signup_GenericMessage = z.object({ ok: z.literal(true), message: z.string() }).openapi('Signup_GenericMessage');

export const Signup_ResetPasswordBody = z.object({
  token: z.string(),
  password: z.string().min(8).openapi({ description: '長度下限以 handler 的 MIN_PASSWORD_LEN 為準' }),
}).openapi('Signup_ResetPasswordBody');

/* ───────── 分享 ───────── */

/** 分享端點（公開檢視／clone）的錯誤是扁平字串：NOT_FOUND 或 RATE_LIMIT。 */
export const Signup_ShareFlatError = z.object({ error: z.enum(['NOT_FOUND', 'RATE_LIMIT']) }).openapi('Signup_ShareFlatError');

const ShareRow = z.record(z.string(), z.unknown());
const ShareNotes = z.object({
  flights: z.array(ShareRow),
  lodgings: z.array(ShareRow),
  reservations: z.array(ShareRow),
  pretripNotes: z.array(ShareRow),
  emergencyContacts: z.array(ShareRow),
});

/**
 * 公開分享檢視。days 與 notes 內的列是 DB 欄位原樣輸出（snake_case 轉 camelCase），
 * 欄位隨資料表演進、與已登入檢視共用 buildAllDays，因此用 record 而非固定結構。
 */
export const Signup_SharePayload = z.object({
  meta: z.object({
    name: z.string(),
    title: z.string().nullable(),
    countries: z.string().nullable(),
    sharedBy: z.string().openapi({ description: '擁有者 display_name；匿名連結為空字串；永遠不含 email／user_id' }),
    destinations: z.array(z.object({ name: z.string() })),
  }),
  days: z.array(z.record(z.string(), z.unknown())),
  notes: ShareNotes,
}).openapi('Signup_SharePayload');

export const Signup_CloneResult = z.object({
  ok: z.literal(true),
  tripId: z.string(),
  daysCreated: z.number().int(),
}).openapi('Signup_CloneResult');

const ShareSections = z.array(z.enum(['flights', 'lodgings', 'reservations', 'pretrip', 'emergency']));

export const Signup_ShareListItem = z.object({
  id: z.number().int(),
  label: z.string(),
  visibleSections: z.string().openapi({ description: '注意：是 JSON 字串（例如 \'["flights"]\'），不是陣列；與建立時回的 visibleSections 陣列型別不一致' }),
  expiresAt: z.number().nullable().openapi({ description: 'epoch ms；null＝永不過期' }),
  viewCount: z.number().int(),
  anonymous: z.number().int().openapi({ description: '0／1' }),
  createdBy: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
}).openapi('Signup_ShareListItem');

export const Signup_ShareList = z.object({ shares: z.array(Signup_ShareListItem) }).openapi('Signup_ShareList');

export const Signup_ShareCreateBody = z.object({
  visibleSections: ShareSections.optional().openapi({ description: '省略時預設 flights／lodgings／pretrip；未知值會被濾掉' }),
  label: z.string().max(80).optional().openapi({ description: '會 trim 並截成 80 字' }),
  expiresAt: z.number().optional().openapi({ description: 'epoch ms；必須是未來且一年內，否則視為永不過期（不報錯）' }),
  anonymous: z.boolean().optional().openapi({ description: '只有 true 才算匿名' }),
}).openapi('Signup_ShareCreateBody');

/** 注意：建立成功回 200（不是 201）；原始 token 只在此回一次。 */
export const Signup_ShareCreated = z.object({
  id: z.number().int(),
  token: z.string(),
  url: z.string().openapi({ example: '/s/<token>' }),
  label: z.string(),
  visibleSections: ShareSections,
  expiresAt: z.number().nullable(),
  anonymous: z.number().int().openapi({ description: '0／1' }),
}).openapi('Signup_ShareCreated');

export const Signup_SharePatchBody = z.object({
  action: z.enum(['revoke', 'rotate', 'update']),
  visibleSections: ShareSections.optional().openapi({ description: '僅 action=update' }),
  label: z.string().optional().openapi({ description: '僅 action=update' }),
  expiresAt: z.number().nullable().optional().openapi({ description: '僅 action=update；有此鍵就會寫入，非法值／null＝清除（永不過期）' }),
  anonymous: z.boolean().optional().openapi({ description: '僅 action=update' }),
}).openapi('Signup_SharePatchBody');

/** PATCH 依 action 回三種形狀之一。 */
export const Signup_SharePatchResult = z.union([
  z.object({ ok: z.literal(true), revoked: z.literal(true) }),
  z.object({ ok: z.literal(true), token: z.string(), url: z.string() }),
  z.object({ ok: z.literal(true), updated: z.literal(true) }),
]).openapi('Signup_SharePatchResult');

export const Signup_ShareDeleted = z.object({ ok: z.literal(true), deleted: z.literal(true) }).openapi('Signup_ShareDeleted');
