import { z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { legacyRoute } from '../../legacy';
import { ApiError } from '../../schemas/common';
import * as S from '../../schemas/signup';
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
  const rateLimited = { description: '請求過多（附 Retry-After）', schema: ApiError };
  const flatShareErrors = {
    404: { description: 'token 不存在／已撤銷／已過期（三者回應一致，刻意不可區分）', schema: S.Signup_ShareFlatError },
    429: { description: 'per-IP／per-user 額度用盡（附 Retry-After）；注意是扁平字串錯誤', schema: S.Signup_ShareFlatError },
  };
  const authErrors = {
    401: { description: '未帶有效 bearer token', schema: ApiError },
    403: { description: '沒有此行程的寫入權限（viewer 也不行；PERM_DENIED）', schema: ApiError },
  };

  legacyRoute(app, {
    method: 'post', path: '/api/oauth/signup', auth: 'none', handler: signupPost, summary: '本地帳號註冊',
    docs: {
      body: S.Signup_SignupBody,
      responses: {
        201: { description: '建立成功。不發任何登入憑證（回應沒有 session／token 欄位），請另走 POST /api/oauth/login；email 待驗證', schema: S.Signup_SignupResult },
        400: { description: 'SIGNUP_CONSENT_REQUIRED／SIGNUP_INVALID_EMAIL／SIGNUP_PASSWORD_TOO_SHORT／SIGNUP_PASSWORD_FORMAT', schema: ApiError },
        409: { description: 'SIGNUP_EMAIL_TAKEN：此 email 已註冊。注意：與 send-verification／forgot-password 不同，signup 不做防列舉，已註冊與新 email 的回應可區分', schema: ApiError },
        429: { description: 'SIGNUP_RATE_LIMITED（per-IP）', schema: ApiError },
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/oauth/verify', auth: 'none', handler: verifyPost, summary: 'Email 驗證（POST）',
    docs: {
      body: S.Signup_VerifyBody,
      responses: {
        200: { description: '驗證成功', schema: S.Signup_OkOnly },
        400: { description: '扁平錯誤字串：missing_token／expired／used', schema: S.Signup_VerifyError },
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/oauth/verify', auth: 'none', handler: verifyGet, summary: 'Email 驗證（舊連結 GET）',
    docs: {
      query: z.object({ token: z.string().optional() }),
      responses: { 302: { description: '導向 /login?verified=1，或 /login?verify_error=missing_token／expired／used／server_error（無 JSON）' } },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/oauth/send-verification', auth: 'none', handler: sendVerificationPost, summary: '寄送驗證信',
    docs: {
      body: S.Signup_EmailBody,
      responses: {
        200: { description: '防帳號列舉：不論 email 是否存在、已驗證、僅 Google 登入，回應一律相同', schema: S.Signup_GenericMessage },
        429: { description: 'VERIFY_RATE_LIMITED（per-IP 或 per-email）', schema: ApiError },
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/oauth/forgot-password', auth: 'none', handler: forgotPasswordPost, summary: '忘記密碼',
    docs: {
      body: S.Signup_EmailBody,
      responses: {
        200: { description: '防帳號列舉：不論 email 是否存在、是否為本地帳號（含僅 Google 登入），回應一律相同', schema: S.Signup_GenericMessage },
        429: { description: 'FORGOT_PASSWORD_RATE_LIMITED（per-IP 或 per-email，文案統一）', schema: ApiError },
      },
    },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/oauth/reset-password', auth: 'none', handler: resetPasswordPost, summary: '重設密碼',
    docs: {
      body: S.Signup_ResetPasswordBody,
      responses: {
        200: { description: '密碼已更新並撤銷該使用者所有 session／token；不自動登入', schema: S.Signup_GenericMessage },
        400: { description: 'RESET_TOKEN_MISSING／RESET_PASSWORD_TOO_SHORT／RESET_TOKEN_INVALID（無效、過期、已使用）／RESET_PASSWORD_FORMAT', schema: ApiError },
        429: { description: 'RESET_RATE_LIMITED（per-IP）', schema: ApiError },
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/share/:token', auth: 'none', handler: shareGet, summary: '公開分享檢視',
    docs: { responses: { 200: { description: '公開分享內容（不含擁有者 email／user_id）', schema: S.Signup_SharePayload }, ...flatShareErrors } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/share/:token/clone', auth: 'required', handler: shareClonePost, summary: '複製分享的行程',
    docs: {
      responses: {
        201: { description: '已複製成新行程（published=0，只帶分享開放的筆記區塊）', schema: S.Signup_CloneResult },
        401: { description: '未帶有效 bearer token', schema: ApiError },
        ...flatShareErrors,
      },
    },
  });
  legacyRoute(app, {
    method: 'get', path: '/api/trips/:id/shares', auth: 'required', handler: sharesGet, summary: '分享連結列表',
    docs: { responses: { 200: { description: '含已撤銷但未刪除的連結；永遠不回 token', schema: S.Signup_ShareList }, ...authErrors } },
  });
  legacyRoute(app, {
    method: 'post', path: '/api/trips/:id/shares', auth: 'required', handler: sharesPost, summary: '建立分享連結',
    docs: {
      body: S.Signup_ShareCreateBody,
      responses: { 200: { description: '注意是 200 不是 201；原始 token 只回這一次', schema: S.Signup_ShareCreated }, ...authErrors },
    },
  });
  legacyRoute(app, {
    method: 'patch', path: '/api/trips/:id/shares/:shareId', auth: 'required', handler: sharePatch, summary: '更新分享連結',
    docs: {
      body: S.Signup_SharePatchBody,
      responses: {
        200: { description: '依 action 回 { ok, revoked } / { ok, token, url } / { ok, updated } 其一', schema: S.Signup_SharePatchResult },
        400: { description: 'DATA_VALIDATION：action 未知，或 update 沒有任何可更新欄位', schema: ApiError },
        ...authErrors,
        404: { description: 'DATA_NOT_FOUND：連結不屬於此行程、已撤銷（revoke 重複／rotate／update）或已過期', schema: ApiError },
      },
    },
  });
  legacyRoute(app, {
    method: 'delete', path: '/api/trips/:id/shares/:shareId', auth: 'required', handler: shareDelete, summary: '撤銷分享連結',
    docs: {
      responses: {
        200: { description: '已刪除', schema: S.Signup_ShareDeleted },
        ...authErrors,
        404: { description: 'DATA_NOT_FOUND', schema: ApiError },
      },
    },
  });
}
