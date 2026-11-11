import { z } from '@hono/zod-openapi';

// ───────── passkey 管理（ADR-0016）：刻意不含公鑰與簽名計數 ─────────

export const Account_Passkey = z.object({
  id: z.string().openapi({ description: '憑證 ID（base64url）；改名、撤銷用它' }),
  name: z.string(),
  transports: z.array(z.string()),
  backupEligible: z.boolean().openapi({ description: '是否為可同步的 passkey' }),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().openapi({ description: '最後一次用它登入的時間；沒用過為 null' }),
}).openapi('Account_Passkey');

export const Account_PasskeyList = z.object({
  passkeys: z.array(Account_Passkey).openapi({ description: '只含本人的，依建立時間舊到新' }),
}).openapi('Account_PasskeyList');

export const Account_PasskeyRenameBody = z.object({
  name: z.string().openapi({ description: '新名稱；前後空白去掉、最多 50 字，去空白後不可為空' }),
}).openapi('Account_PasskeyRenameBody');

export const Account_PasskeyRevoked = z.object({
  ok: z.literal(true),
  revoked_id: z.string(),
}).openapi('Account_PasskeyRevoked');

// ───────── 重新驗證（step-up）發證 ─────────

export const Account_ReauthOptions = z.object({
  challenge: z.string().openapi({ description: '一次性 step-up 挑戰（base64url）；5 分鐘內有效，只能用一次，綁定本人與目前 session' }),
  rpId: z.string(),
  timeout: z.number().int(),
  userVerification: z.literal('required'),
  allowCredentials: z.array(z.object({ type: z.literal('public-key'), id: z.string(), transports: z.array(z.string()).optional() }))
    .openapi({ description: '只含本人的 passkey；沒有 passkey 時為空陣列（改走密碼）' }),
}).openapi('Account_ReauthOptions');

export const Account_ReauthPasskeyBody = z.object({
  credential: z.object({
    id: z.string().openapi({ description: '憑證 ID（base64url）' }),
    type: z.literal('public-key').optional(),
    response: z.object({
      clientDataJSON: z.string().openapi({ description: 'base64url' }),
      authenticatorData: z.string().openapi({ description: 'base64url' }),
      signature: z.string().openapi({ description: 'base64url（DER）' }),
      userHandle: z.string().nullable().optional(),
    }),
  }),
}).openapi('Account_ReauthPasskeyBody');

export const Account_ReauthPasswordBody = z.object({
  password: z.string().openapi({ description: '目前密碼；沒帶或錯誤一律 REAUTH_INVALID' }),
}).openapi('Account_ReauthPasswordBody');

export const Account_ReauthProof = z.object({
  proof: z.string().openapi({ description: '不透明證明；敏感操作以 X-Step-Up-Proof 標頭帶上。綁定本人與目前 session，不可轉用' }),
  expires_in: z.number().int().openapi({ description: '有效秒數（300）；期間內可重複使用' }),
}).openapi('Account_ReauthProof');
