/**
 * 所有路由的登記點。每一組 handler 有自己的檔案（src/routes/groups/*），各自只登記自己的路由，
 * 平行開發時互不衝突。新增一組：建立 groups/<name>.ts、在這裡加一行呼叫。
 *
 * 搬移舊 handler 的做法（行為不變）：
 *   1. 把舊 handler 複製到 src/routes/handlers/<原路徑>.ts，只改 import 路徑（見下）；
 *   2. 在對應的 groups 檔用 legacyRoute(app, { method, path, auth, handler: onRequestXxx }) 登記；
 *   3. 把舊的 HTTP 邊界測試複製到 tests/baseline/，改 import 後先確認紅燈（路由不存在），再讓它變綠。
 * import 對照：`./_errors`→`../../../errors`、`./_auth`→`../../../lib/permissions`、`./_utils`→`../../../lib/utils`、
 * `../../src/server/X`→`../../../lib/X`，其餘 `_foo_bar`→`lib/foo-bar`（深度依檔案位置調整）。
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { registerAccountRoutes } from './groups/account';
import { registerDaysEntriesRoutes } from './groups/days-entries';
import { registerNotesRoutes } from './groups/notes';
import { registerOauthMiscRoutes } from './groups/oauth-misc';
import { registerPoisPlacesRoutes } from './groups/pois-places';
import { registerRequestsOpsRoutes } from './groups/requests-ops';
import { registerSignupRoutes } from './groups/signup';
import { registerTripsCoreRoutes } from './groups/trips-core';

export function registerLegacyRoutes(app: OpenAPIHono<AppEnv>): void {
  registerAccountRoutes(app);
  registerDaysEntriesRoutes(app);
  registerNotesRoutes(app);
  registerOauthMiscRoutes(app);
  registerPoisPlacesRoutes(app);
  registerRequestsOpsRoutes(app);
  registerSignupRoutes(app);
  registerTripsCoreRoutes(app);
}
