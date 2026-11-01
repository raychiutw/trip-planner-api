import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as jwksGet } from '../handlers/oauth/.well-known/jwks.json';
import { onRequestGet as openidConfigGet } from '../handlers/oauth/.well-known/openid-configuration';
import { onRequestGet as authorizeGet } from '../handlers/oauth/authorize';
import { onRequestGet as authRequestGet, onRequestPost as authRequestDecide } from '../handlers/oauth/authorize-requests';
import { onRequestGet as callbackGoogleGet } from '../handlers/oauth/callback/google';
import { onRequestGet as clientInfoGet } from '../handlers/oauth/client-info';
import { onRequestPost as downscopePost } from '../handlers/oauth/downscope';
import { onRequestGet as loginGoogleGet } from '../handlers/oauth/login/google';
import { onRequestGet as logoutGet, onRequestPost as logoutPost } from '../handlers/oauth/logout';
import { onRequestPost as mintRestrictedPost } from '../handlers/oauth/mint-restricted';
import { onRequestPost as revokePost } from '../handlers/oauth/revoke';
import { onRequestGet as userinfoGet } from '../handlers/oauth/userinfo';

/**
 * OAuth 雜項端點。auth 模式對照舊 _middleware：`/api/oauth/*` 全部公開（端點自管認證），
 * 例外是 downscope（舊版也走 middleware 認證）。新增的 authorize requests 與 logout、userinfo 需要 bearer。
 * - revoke：client 認證（client_secret／public client_id）由 handler 自己做。
 * - mint-restricted：只收 TRIPLINE_API_SECRET，由 handler 自己做（不是 user bearer）。
 * `_id_token` 只是 lib（token endpoint 之後接），不登記路由。
 */
export function registerOauthMiscRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/oauth/.well-known/jwks.json', auth: 'none', handler: jwksGet, summary: 'OIDC JWKS' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/.well-known/openid-configuration', auth: 'none', handler: openidConfigGet, summary: 'OIDC discovery' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/authorize', auth: 'none', handler: authorizeGet, summary: '第三方授權入口（存 AuthRequest 並導向 web）' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/authorize/requests/:id', auth: 'required', handler: authRequestGet, summary: '授權請求的同意畫面資料' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/authorize/requests/:id/approve', auth: 'required', handler: authRequestDecide, summary: '同意授權（回 redirect_to）' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/authorize/requests/:id/deny', auth: 'required', handler: authRequestDecide, summary: '拒絕授權（回 redirect_to）' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/client-info', auth: 'none', handler: clientInfoGet, summary: 'client 公開資訊' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/downscope', auth: 'required', handler: downscopePost, summary: '換發單一行程的受限 token' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/mint-restricted', auth: 'none', handler: mintRestrictedPost, summary: '（內部）由 request_id 簽發受限 token' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/revoke', auth: 'none', handler: revokePost, summary: 'RFC 7009 token revocation' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/logout', auth: 'required', handler: logoutGet, summary: '登出（撤銷目前 grant）' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/logout', auth: 'required', handler: logoutPost, summary: '登出（撤銷目前 grant）' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/userinfo', auth: 'required', handler: userinfoGet, summary: '目前使用者資料' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/login/google', auth: 'none', handler: loginGoogleGet, summary: 'Google 登入（導向 Google）' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/callback/google', auth: 'none', handler: callbackGoogleGet, summary: 'Google 登入 callback' });
}
