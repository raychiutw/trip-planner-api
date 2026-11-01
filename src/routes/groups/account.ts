import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { onRequestGet as accountAiAuthorizationGet, onRequestPost as accountAiAuthorizationPost } from '../handlers/account/ai-authorization';
import { onRequestGet as accountConnectedAppsGet } from '../handlers/account/connected-apps';
import { onRequestDelete as accountConnectedAppsClientIdDelete } from '../handlers/account/connected-apps/@client_id';
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
export function registerAccountRoutes(app: OpenAPIHono<AppEnv>): void {
  legacyRoute(app, { method: 'get', path: '/api/account/ai-authorization', auth: 'required', handler: accountAiAuthorizationGet, summary: 'AI 授權狀態／授權' });
  legacyRoute(app, { method: 'post', path: '/api/account/ai-authorization', auth: 'required', handler: accountAiAuthorizationPost, summary: 'AI 授權狀態／授權' });
  legacyRoute(app, { method: 'get', path: '/api/account/connected-apps', auth: 'required', handler: accountConnectedAppsGet, summary: '已連線的應用程式' });
  legacyRoute(app, { method: 'delete', path: '/api/account/connected-apps/:client_id', auth: 'required', handler: accountConnectedAppsClientIdDelete, summary: '撤銷應用程式授權' });
  legacyRoute(app, { method: 'get', path: '/api/account', auth: 'required', handler: accountIndexGet, summary: '帳號刪除預覽／刪除帳號' });
  legacyRoute(app, { method: 'delete', path: '/api/account', auth: 'required', handler: accountIndexDelete, summary: '帳號刪除預覽／刪除帳號' });
  legacyRoute(app, { method: 'get', path: '/api/account/notifications', auth: 'required', handler: accountNotificationsGet, summary: '通知偏好' });
  legacyRoute(app, { method: 'patch', path: '/api/account/notifications', auth: 'required', handler: accountNotificationsPatch, summary: '通知偏好' });
  legacyRoute(app, { method: 'patch', path: '/api/account/profile', auth: 'required', handler: accountProfilePatch, summary: '更新個人資料' });
  legacyRoute(app, { method: 'get', path: '/api/account/sessions', auth: 'required', handler: accountSessionsGet, summary: '有效連線（OAuth grant）' });
  legacyRoute(app, { method: 'delete', path: '/api/account/sessions', auth: 'required', handler: accountSessionsDelete, summary: '有效連線（OAuth grant）' });
  legacyRoute(app, { method: 'delete', path: '/api/account/sessions/:sid', auth: 'required', handler: accountSessionsSidDelete, summary: '撤銷指定連線' });
  legacyRoute(app, { method: 'get', path: '/api/account/stats', auth: 'required', handler: accountStatsGet, summary: '帳號統計' });
  legacyRoute(app, { method: 'post', path: '/api/dev/apps', auth: 'required', handler: devAppsPost, summary: '開發者應用程式' });
  legacyRoute(app, { method: 'get', path: '/api/dev/apps', auth: 'required', handler: devAppsGet, summary: '開發者應用程式' });
  legacyRoute(app, { method: 'get', path: '/api/dev/apps/:client_id', auth: 'required', handler: devAppsClientIdGet, summary: '開發者應用程式明細' });
  legacyRoute(app, { method: 'patch', path: '/api/dev/apps/:client_id', auth: 'required', handler: devAppsClientIdPatch, summary: '開發者應用程式明細' });
  legacyRoute(app, { method: 'delete', path: '/api/dev/apps/:client_id', auth: 'required', handler: devAppsClientIdDelete, summary: '開發者應用程式明細' });
  legacyRoute(app, { method: 'get', path: '/api/permissions', auth: 'required', handler: permissionsGet, summary: '行程成員權限' });
  legacyRoute(app, { method: 'post', path: '/api/permissions', auth: 'required', handler: permissionsPost, summary: '行程成員權限' });
  legacyRoute(app, { method: 'delete', path: '/api/permissions/:id', auth: 'required', handler: permissionsIdDelete, summary: '單一成員權限' });
  legacyRoute(app, { method: 'patch', path: '/api/permissions/:id', auth: 'required', handler: permissionsIdPatch, summary: '單一成員權限' });
  legacyRoute(app, { method: 'get', path: '/api/invitations', auth: 'optional', handler: invitationsGet, summary: '邀請預覽／待處理邀請' });
  legacyRoute(app, { method: 'post', path: '/api/invitations/accept', auth: 'required', handler: invitationsAcceptPost, summary: '接受邀請' });
  legacyRoute(app, { method: 'post', path: '/api/invitations/revoke', auth: 'required', handler: invitationsRevokePost, summary: '撤銷邀請' });
}
