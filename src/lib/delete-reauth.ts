/**
 * 帳號刪除的 fresh-auth：challenge 狀態機（自舊入口 functions/api/account/_deleteReauth.ts 移植）。
 *
 * 新 api 沒有 cookie，所以舊入口「瀏覽器 session 證明（AccountDeleteProof）」那一半不移植，改成兩種呼叫面共用 challenge：
 * mobile（與環境相符的 mobile client）與 web（tripline-web）。challenge 以 `surface` 區分，兩邊不可互用；
 * 舊紀錄沒有 surface 欄＝mobile。
 * challenge 存 oauth_models（name='AccountDeleteChallenge'），payload `{ uid, grantId, clientId, status, surface }`；
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

export type ChallengeSurface = 'web' | 'mobile';
export const WEB_CLIENT_ID = 'tripline-web';

export interface MobileChallenge {
  uid: string;
  clientId: string;
  grantId: string;
  status: ChallengeStatus;
  surface: ChallengeSurface;
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

/**
 * web 驗證完成後導回的固定網址：`${WEB_ORIGIN}/account?deleteReauth=done|failed`（WEB_ORIGIN 缺省用 PUBLIC_ORIGIN）。
 * 完全由 server 設定組成，**不收任何呼叫者傳入的網址或參數**（避免 open redirect）。
 * 設定驗證同 mobileCallbackUrl：production／preview 一律 https；只有 development 允許 http loopback；
 * 只能是純 origin（無 path、query、hash、userinfo）。
 */
export function webReauthRedirect(
  env: Pick<Env, 'WEB_ORIGIN' | 'PUBLIC_ORIGIN' | 'ENVIRONMENT'>, result: 'done' | 'failed',
): string {
  const dev = env.ENVIRONMENT === 'development';
  let url: URL;
  try { url = new URL(env.WEB_ORIGIN || env.PUBLIC_ORIGIN || ''); } catch { throw new AppError('SERVER_MISCONFIG', 'WEB_ORIGIN 未設定'); }
  const devLoopback = dev && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((url.protocol !== 'https:' && !devLoopback) || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new AppError('SERVER_MISCONFIG', 'WEB_ORIGIN 設定無效');
  }
  return `${url.origin}/account?deleteReauth=${result}`;
}

export interface AccountActor { uid: string; grantId: string; clientId: string; surface: ChallengeSurface }

function allowedOrigins(env: Env): Set<string> {
  return new Set((env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * 判斷 token 是哪一種呼叫面；都不是回 null。共同條件：user-bound、有 grant、非 service token、非受限 token。
 *  - mobile：client 必須是與環境相符的 mobile client。
 *  - web：client 必須是 tripline-web，且請求 Origin（有帶時）在 ALLOWED_ORIGINS。
 */
export function resolveAccountSurface(
  auth: AuthData, env: Env, request: Request,
): ChallengeSurface | null {
  if (auth.isServiceToken || !auth.userId || !auth.grantId || auth.restrictTrip) return null;
  const contract = mobileOAuthContract(env, request);
  if (contract && auth.clientId === contract.clientId) return 'mobile';
  if (auth.clientId === WEB_CLIENT_ID) {
    const origin = request.headers.get('Origin');
    if (origin !== null && !allowedOrigins(env).has(origin)) return null;
    return 'web';
  }
  return null;
}

/** 呼叫者必須是 mobile 或 web 面的 user-bound、有 grant、非受限 token；其他 client 一律 PERM_DENIED。 */
export function requireAccountActor(
  context: { data: unknown; env: Env; request: Request },
): AccountActor {
  const auth = (context.data as { auth?: AuthData | null } | undefined)?.auth;
  if (!auth) throw new AppError('AUTH_REQUIRED');
  const surface = resolveAccountSurface(auth, context.env, context.request);
  if (!surface) throw new AppError('PERM_DENIED');
  return { uid: auth.userId!, grantId: auth.grantId!, clientId: auth.clientId!, surface };
}

export async function createMobileDeleteChallenge(
  db: D1Database, uid: string, grantId: string, clientId: string, surface: ChallengeSurface = 'mobile',
): Promise<string> {
  const id = generateOpaqueToken();
  await db.prepare('INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)')
    .bind(CHALLENGE_NAME, id, JSON.stringify({ uid, grantId, clientId, status: 'pending', surface }), Date.now() + DELETE_PROOF_TTL_MS).run();
  return id;
}

export async function readMobileDeleteChallenge(db: D1Database, id: string): Promise<(MobileChallenge & { expired: boolean }) | null> {
  const row = await db.prepare('SELECT payload, expires_at FROM oauth_models WHERE name = ? AND id = ?')
    .bind(CHALLENGE_NAME, id).first<{ payload: string; expires_at: number }>();
  if (!row) return null;
  const payload = JSON.parse(row.payload) as Omit<MobileChallenge, 'surface'> & { surface?: ChallengeSurface };
  return { ...payload, surface: payload.surface === 'web' ? 'web' : 'mobile', expired: row.expires_at < Date.now() };
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

/** 這個 grant 目前有沒有一個 verified、未過期、同 surface 的 challenge（GET /api/account 的 reauthenticated 用）。 */
export async function hasVerifiedChallenge(db: D1Database, actor: AccountActor): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM oauth_models WHERE name = ? AND expires_at >= ?
      AND json_extract(payload, '$.uid') = ? AND json_extract(payload, '$.grantId') = ?
      AND json_extract(payload, '$.clientId') = ? AND json_extract(payload, '$.status') = 'verified'
      AND COALESCE(json_extract(payload, '$.surface'), 'mobile') = ? LIMIT 1`)
    .bind(CHALLENGE_NAME, Date.now(), actor.uid, actor.grantId, actor.clientId, actor.surface).first();
  return row !== null;
}
