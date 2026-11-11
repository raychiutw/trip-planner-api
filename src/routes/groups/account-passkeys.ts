import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as P from '../../schemas/account-passkeys';
import { onRequestGet, onRequestPatch, onRequestDelete } from '../handlers/account/passkeys/manage';

const err = (description: string) => ({ description, schema: ApiError });
const E401 = err('未登入、token 無效或已過期（code: AUTH_REQUIRED）');
const E403 = err('token 屬於非第一方的 client，或是 trip 範圍的受限 token（code: PERM_DENIED）');
const E404 = err('id 不存在、已撤銷或不屬於自己；一律同一個回應，不洩漏存在與否（code: PASSKEY_NOT_FOUND）');

/** passkey 管理：列出、改名、撤銷（註冊在 groups/account.ts）。 */
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
      401: E401, 403: E403, 404: E404,
    } },
  });
}
