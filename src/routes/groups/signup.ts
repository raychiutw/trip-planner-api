import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestPost as signupPost } from '../handlers/oauth/signup';
import { onRequestPost as verifyPost, onRequestGet as verifyGet } from '../handlers/oauth/verify';
import { onRequestPost as sendVerificationPost } from '../handlers/oauth/send-verification';
import { onRequestPost as forgotPasswordPost } from '../handlers/oauth/forgot-password';
import { onRequestPost as resetPasswordPost } from '../handlers/oauth/reset-password';
import { onRequestGet as shareGet } from '../handlers/share/@token';
import { onRequestPost as shareClonePost } from '../handlers/share/@token/clone';
import { onRequestGet as sharesGet, onRequestPost as sharesPost } from '../handlers/trips/@id/shares';
import { onRequestPatch as sharePatch, onRequestDelete as shareDelete } from '../handlers/trips/@id/shares/@shareId';

/**
 * 註冊 / 驗證 / 忘記密碼 / 分享。
 * auth 對照舊 _middleware.ts：/api/oauth/* 全公開（端點自管）；GET /api/share/:token 公開
 * （token 即憑證）；clone 與 trips/:id/shares 管理端點需登入。
 */
export function registerSignupRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'post', path: '/api/oauth/signup', auth: 'none', handler: signupPost, summary: '本地帳號註冊' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/verify', auth: 'none', handler: verifyPost, summary: 'Email 驗證（POST）' });
  legacyRoute(app, { method: 'get', path: '/api/oauth/verify', auth: 'none', handler: verifyGet, summary: 'Email 驗證（舊連結 GET）' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/send-verification', auth: 'none', handler: sendVerificationPost, summary: '寄送驗證信' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/forgot-password', auth: 'none', handler: forgotPasswordPost, summary: '忘記密碼' });
  legacyRoute(app, { method: 'post', path: '/api/oauth/reset-password', auth: 'none', handler: resetPasswordPost, summary: '重設密碼' });
  legacyRoute(app, { method: 'get', path: '/api/share/:token', auth: 'none', handler: shareGet, summary: '公開分享檢視' });
  legacyRoute(app, { method: 'post', path: '/api/share/:token/clone', auth: 'required', handler: shareClonePost, summary: '複製分享的行程' });
  legacyRoute(app, { method: 'get', path: '/api/trips/:id/shares', auth: 'required', handler: sharesGet, summary: '分享連結列表' });
  legacyRoute(app, { method: 'post', path: '/api/trips/:id/shares', auth: 'required', handler: sharesPost, summary: '建立分享連結' });
  legacyRoute(app, { method: 'patch', path: '/api/trips/:id/shares/:shareId', auth: 'required', handler: sharePatch, summary: '更新分享連結' });
  legacyRoute(app, { method: 'delete', path: '/api/trips/:id/shares/:shareId', auth: 'required', handler: shareDelete, summary: '撤銷分享連結' });
}
