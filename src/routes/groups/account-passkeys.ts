import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as P from '../../schemas/account-passkeys';
import { onRequestGet, onRequestPatch, onRequestDelete } from '../handlers/account/passkeys/manage';
import { onRequestPostOptions as reauthOptionsPost, onRequestPostPasskey as reauthPasskeyPost, onRequestPostPassword as reauthPasswordPost } from '../handlers/account/reauth';

const err = (description: string) => ({ description, schema: ApiError });
const E401 = err('未登入、token 無效或已過期（code: AUTH_REQUIRED）');
const E403 = err('token 屬於非第一方的 client，或是 trip 範圍的受限 token（code: PERM_DENIED）');
const E404 = err('id 不存在、已撤銷或不屬於自己；一律同一個回應，不洩漏存在與否（code: PASSKEY_NOT_FOUND）');

/** passkey 管理：列出、改名、撤銷（註冊在 groups/account.ts）；重新驗證（step-up）發證。 */
export function registerAccountPasskeyRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, {
    method: 'get', path: '/api/account/passkeys', auth: 'required', handler: onRequestGet, summary: '列出我的 passkey',
    docs: { responses: { 200: { description: '只含本人的 passkey；不回公鑰與簽名計數', schema: P.Account_PasskeyList }, 401: E401, 403: E403 } },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/account/passkeys/:id', auth: 'required', handler: onRequestPatch, summary: 'passkey 改名',
    docs: { body: P.Account_PasskeyRenameBody, responses: {
      200: { description: '已改名，回更新後的 passkey', schema: P.Account_Passkey },
      400: err('name 不是字串、去空白後為空，或 body 不是合法 JSON（code: DATA_VALIDATION）'),
      401: E401, 403: E403, 404: E404,
    } },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/account/passkeys/:id', auth: 'required', handler: onRequestDelete, summary: '撤銷 passkey',
    docs: { responses: {
      200: { description: '憑證資料已刪除（之後不能再用來登入）；已寄「移除了一組 passkey」通知信（失敗不影響結果）；不影響任何 session／token', schema: P.Account_PasskeyRevoked },
      401: E401, 403: err('token 屬於非第一方的 client，或是 trip 範圍的受限 token（PERM_DENIED）；或 REAUTH_REQUIRED：伺服器開啟 STEP_UP_ENFORCE 時，使用者本人的登入沒帶有效重新驗證證明（標頭 X-Step-Up-Proof；到 POST /api/account/reauth/* 換證明後重試）'), 404: E404,
    } },
  });
  const E403_REAUTH = err('驗證失敗（挑戰無效／已用／逾期、他人或不存在的憑證、簽名錯、缺使用者驗證、網域不符、簽名計數倒退、密碼不正確或沒帶）一律同一個回應（code: REAUTH_INVALID，刻意不用 401，避免 client 當成登入過期）；或非第一方 client／受限 token（PERM_DENIED）');
  const E429_REAUTH = err('失敗過多被暫時鎖定（passkey 與密碼共用），Retry-After 為等待秒數（code: REAUTH_RATE_LIMITED）');
  legacyRoute(app, {
    method: 'post', path: '/api/account/reauth/options', auth: 'required', handler: reauthOptionsPost, summary: '重新驗證：取得 passkey 挑戰',
    docs: { bodyRequired: false, responses: {
      200: { description: 'WebAuthn 取得選項（navigator.credentials.get 的 publicKey）；挑戰用途與登入／註冊分開，5 分鐘內有效、只能用一次、綁定本人與目前 session', schema: P.Account_ReauthOptions },
      401: E401, 403: err('非第一方 client 或受限 token（code: PERM_DENIED）'), 429: err('取得挑戰過於頻繁（code: REAUTH_RATE_LIMITED）'),
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/account/reauth/passkey', auth: 'required', handler: reauthPasskeyPost, summary: '重新驗證：用 passkey 換 step-up 證明',
    docs: { body: P.Account_ReauthPasskeyBody, responses: {
      200: { description: '證明 5 分鐘內有效、綁定本人與目前 session（之後的敏感端點以 X-Step-Up-Proof 標頭檢查）', schema: P.Account_ReauthProof },
      401: E401, 403: E403_REAUTH, 429: E429_REAUTH,
    } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/account/reauth/password', auth: 'required', handler: reauthPasswordPost, summary: '重新驗證：用目前密碼換 step-up 證明（沒有 passkey 的人）',
    docs: { body: P.Account_ReauthPasswordBody, responses: {
      200: { description: '證明 5 分鐘內有效、綁定本人與目前 session', schema: P.Account_ReauthProof },
      401: E401, 403: E403_REAUTH,
      409: err('此帳號沒有設定密碼（只有第三方登入），請改用 passkey（code: REAUTH_NO_PASSWORD）'),
      429: E429_REAUTH,
    } },
  });
}
