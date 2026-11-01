/**
 * 帳號刪除的 fresh-auth：mobile challenge 狀態機（自舊入口 functions/api/account/_deleteReauth.ts 移植）。
 *
 * 新 api 沒有 cookie，所以舊入口「瀏覽器 session 證明（AccountDeleteProof）」那一半不移植，只留 mobile challenge。
 * challenge 存 oauth_models（name='AccountDeleteChallenge'），payload `{ uid, grantId, clientId, status }`；
 * `$.uid` 讓帳號抹除時一併清掉（OAUTH_MODELS_ERASE_SQL）。
 *
 * 狀態：pending →(開始 Google 驗證) started →(callback 驗證成功) verified →(DELETE /api/account) used；
 * pending／started／verified 可被取消為 cancelled；started 在驗證失敗時為 failed。每次轉換都是帶 WHERE 的原子 UPDATE。
 */
import { AppError } from '../errors';
import { generateOpaqueToken } from './utils';
import { MOBILE_DEV_REDIRECT, mobileOAuthContract } from './mobile-oauth';
import type { AuthData, Env } from '../env';

const CHALLENGE_NAME = 'AccountDeleteChallenge';
/** challenge 與 Google 驗證 state 的有效期；Google auth_time 的新鮮度也用同一個值。 */
export const DELETE_PROOF_TTL_MS = 5 * 60 * 1000;

export type ChallengeStatus = 'pending' | 'started' | 'verified' | 'failed' | 'cancelled' | 'used';

export interface MobileChallenge {
  uid: string;
  clientId: string;
  grantId: string;
  status: ChallengeStatus;
}

/**
 * mobile callback 的設定驗證。production／preview 一律要 https；
 * 只有 development 允許 http loopback，且沒設定時以 contract 的 dev 值為預設。
 */
export function mobileCallbackUrl(env: Pick<Env, 'MOBILE_OAUTH_CALLBACK_URL' | 'ENVIRONMENT'>): URL {
  const dev = env.ENVIRONMENT === 'development';
  let url: URL;
  try { url = new URL(env.MOBILE_OAUTH_CALLBACK_URL ?? (dev ? MOBILE_DEV_REDIRECT : '')); } catch { throw new AppError('SERVER_MISCONFIG', 'Mobile OAuth callback 未設定'); }
  const devLoopback = dev && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((url.protocol !== 'https:' && !devLoopback) || url.search || url.hash || url.username || url.password) {
    throw new AppError('SERVER_MISCONFIG', 'Mobile OAuth callback 設定無效');
  }
  return url;
}

/** 呼叫者必須是與環境相符的 mobile client、user-bound、有 grant、非受限 token。 */
export function requireMobileAccountActor(
  context: { data: unknown; env: Env; request: Request },
): { uid: string; grantId: string; clientId: string } {
  const auth = (context.data as { auth?: AuthData | null } | undefined)?.auth;
  if (!auth) throw new AppError('AUTH_REQUIRED');
  const contract = mobileOAuthContract(context.env, context.request);
  if (!contract || auth.isServiceToken || auth.clientId !== contract.clientId || !auth.userId || !auth.grantId || auth.restrictTrip) {
    throw new AppError('PERM_DENIED');
  }
  return { uid: auth.userId, grantId: auth.grantId, clientId: auth.clientId };
}

export async function createMobileDeleteChallenge(db: D1Database, uid: string, grantId: string, clientId: string): Promise<string> {
  const id = generateOpaqueToken();
  await db.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)')
    .bind(CHALLENGE_NAME, id, JSON.stringify({ uid, grantId, clientId, status: 'pending' }), Date.now() + DELETE_PROOF_TTL_MS).run();
  return id;
}

export async function readMobileDeleteChallenge(db: D1Database, id: string): Promise<(MobileChallenge & { expired: boolean }) | null> {
  const row = await db.prepare('SELECT payload, expires_at FROM oauth_models WHERE name = ? AND id = ?')
    .bind(CHALLENGE_NAME, id).first<{ payload: string; expires_at: number }>();
  if (!row) return null;
  return { ...JSON.parse(row.payload) as MobileChallenge, expired: row.expires_at < Date.now() };
}

export async function transitionMobileDeleteChallenge(
  db: D1Database, id: string, uid: string, grantId: string, from: ChallengeStatus, to: ChallengeStatus,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE oauth_models SET payload = json_set(payload, '$.status', ?)
    WHERE name = ? AND id = ? AND expires_at >= ? AND json_extract(payload, '$.uid') = ?
      AND json_extract(payload, '$.grantId') = ? AND json_extract(payload, '$.status') = ?`)
    .bind(to, CHALLENGE_NAME, id, Date.now(), uid, grantId, from).run();
  return (result.meta?.changes ?? 0) === 1;
}
