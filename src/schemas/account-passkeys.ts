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
