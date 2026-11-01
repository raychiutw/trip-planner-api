/**
 * POST /api/oauth/logout（GET 同義）—— 登出 = 撤銷目前 bearer 所屬的 grant。
 *
 * 設計變更：新 api 沒有 cookie session，所以不再清 cookie、也不再 302。
 * 改為：找出這張 access token 的 grantId，`revokeByGrantId` 一併刪掉同 grant 的 AccessToken 與
 * RefreshToken（整個 token family），回 204。畫面導向由 web 自己處理。
 * 只動「呼叫者自己的」grant：grantId 取自它出示的 token，不收任何請求參數。
 */
import { AppError } from '../../../errors';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import { getAuth } from '../../../lib/utils';
import type { Env } from '../../../env';

/** 取出 `Authorization: Bearer|DPoP <token>` 的 token（bearerAuth 已驗過，這裡只是取值）。 */
function presentedToken(request: Request): string | null {
  const m = /^(?:Bearer|DPoP)[ \t]+(.*)$/i.exec(request.headers.get('Authorization') ?? '');
  return m?.[1]?.trim() || null;
}

async function logout(context: { request: Request; env: Env; data: unknown }): Promise<Response> {
  const auth = getAuth(context);
  if (!auth) throw new AppError('AUTH_REQUIRED');
  const token = presentedToken(context.request);
  const row = token ? await new D1Adapter(context.env.DB, 'AccessToken').find(token) : undefined;
  if (!row) throw new AppError('AUTH_REQUIRED');

  const grantId = typeof row.grantId === 'string' ? row.grantId : undefined;
  if (grantId) {
    await new D1Adapter(context.env.DB, 'AccessToken').revokeByGrantId(grantId);
  } else {
    // 沒有 grantId 的舊 token：至少撤銷這一張
    await new D1Adapter(context.env.DB, 'AccessToken').destroy(token!);
  }

  await recordAuthEvent(context.env.DB, context.request, {
    eventType: 'logout',
    outcome: 'success',
    userId: auth.userId,
    clientId: auth.clientId ?? null,
  }, context.env);

  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

export const onRequestGet: PagesFunction<Env> = (context) => logout(context);
export const onRequestPost: PagesFunction<Env> = (context) => logout(context);
