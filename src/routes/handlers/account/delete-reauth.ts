/**
 * 帳號刪除的 Google 重新驗證 challenge（mobile）：
 *   POST   /api/account/delete-reauth                    建立 challenge，回 { challengeId, authorizeUrl, expiresIn }
 *   GET    /api/account/delete-reauth?challenge_id=…     查狀態 { status }（過期為 expired）
 *   DELETE /api/account/delete-reauth?challenge_id=…     取消
 *
 * 自舊入口 functions/api/account/delete-reauth.ts 移植，路徑與 wire 格式不變。
 * 認證：與環境相符的 mobile client 簽發、綁 grant 的 user bearer（requireMobileAccountActor）。
 * challenge 綁 uid + grantId + clientId；別人的、別的 grant 的一律 404 DATA_NOT_FOUND（不洩漏存在與否）。
 */
import { AppError } from '../../../errors';
import { getPublicOrigin, rawJson } from '../../../lib/utils';
import { mobileOAuthContract } from '../../../lib/mobile-oauth';
import {
  DELETE_PROOF_TTL_MS, createMobileDeleteChallenge, mobileCallbackUrl, readMobileDeleteChallenge,
  requireMobileAccountActor, transitionMobileDeleteChallenge,
} from '../../../lib/delete-reauth';
import type { Env } from '../../../env';

type Context = Parameters<PagesFunction<Env>>[0];

async function ownedChallenge(context: Context) {
  const actor = requireMobileAccountActor(context);
  const id = new URL(context.request.url).searchParams.get('challenge_id');
  if (!id) throw new AppError('DATA_VALIDATION', 'challenge_id 必填');
  const challenge = await readMobileDeleteChallenge(context.env.DB, id);
  if (!challenge || challenge.uid !== actor.uid || challenge.grantId !== actor.grantId || challenge.clientId !== actor.clientId) {
    throw new AppError('DATA_NOT_FOUND');
  }
  return { id, challenge, actor };
}

const noStore = (response: Response) => { response.headers.set('Cache-Control', 'no-store'); return response; };

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const actor = requireMobileAccountActor(context);
  if (mobileCallbackUrl(context.env).toString() !== mobileOAuthContract(context.env, context.request)?.redirectUri) {
    throw new AppError('SERVER_MISCONFIG', 'Mobile OAuth callback 與環境不符');
  }
  const identity = await context.env.DB.prepare("SELECT 1 FROM auth_identities WHERE user_id = ? AND provider = 'google'")
    .bind(actor.uid).first();
  if (!identity) throw new AppError('ACCOUNT_DELETE_REAUTH_REQUIRED', '此帳號沒有可用的重新驗證方式');
  const challengeId = await createMobileDeleteChallenge(context.env.DB, actor.uid, actor.grantId, actor.clientId);
  const authorizeUrl = new URL('/api/oauth/login/google', getPublicOrigin(context.env, context.request));
  authorizeUrl.searchParams.set('purpose', 'account-delete');
  authorizeUrl.searchParams.set('challenge', challengeId);
  return noStore(rawJson({ challengeId, authorizeUrl: authorizeUrl.toString(), expiresIn: DELETE_PROOF_TTL_MS / 1000 }));
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { challenge } = await ownedChallenge(context);
  return noStore(rawJson({ status: challenge.expired ? 'expired' : challenge.status, expiresIn: challenge.expired ? 0 : undefined }));
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { id, challenge, actor } = await ownedChallenge(context);
  if (challenge.status === 'used') throw new AppError('DATA_CONFLICT', '驗證已使用');
  // failed 是終態：app 在 callback 回報失敗後常會再送一次取消收尾，視為冪等的清理，不回 409。
  if (challenge.status === 'failed') return rawJson({ status: 'failed' });
  if (challenge.expired) throw new AppError('ACCOUNT_DELETE_REAUTH_REQUIRED', '驗證已過期');
  if (challenge.status !== 'cancelled') {
    let cancelled = false;
    for (const status of ['pending', 'started', 'verified'] as const) {
      cancelled ||= await transitionMobileDeleteChallenge(context.env.DB, id, actor.uid, actor.grantId, status, 'cancelled');
    }
    if (!cancelled) throw new AppError('DATA_CONFLICT', '驗證狀態已變更');
  }
  return rawJson({ status: 'cancelled' });
};
