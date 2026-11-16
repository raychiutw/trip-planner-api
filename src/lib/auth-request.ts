/**
 * 授權請求（AuthRequest）的單一出處：payload 形狀、TTL、四個操作（create／peek／setIntent／take）。
 * 所有 handler 只呼叫這裡；`oauth_models` 的 AuthRequest 列只在這個檔案內讀寫。
 *
 * 規則：
 * - 單次使用：take 先 find 再條件式 DELETE 搶佔，只有一個贏家（重放、平行重送都拿到 undefined）。
 * - 意圖只綁定設定它的使用者（intent_user_id）。
 * - setIntent 是條件式 UPDATE：請求已被 take 或過期就不會被復活。
 */
import { D1Adapter } from './oauth-d1-adapter';
import { isBiometricIntent, type BiometricHint, type BiometricIntent } from './oauth-contract';
import type { ValidatedRequest } from './oauth-server/validate-authorize-request';
import { generateOpaqueToken } from './utils';

const NAME = 'AuthRequest';
export const AUTH_REQUEST_TTL_SEC = 10 * 60;

/** AuthRequest 的內容：驗過的參數（consent 與 code 都只信這份，不信 web 傳入的值）。 */
export interface AuthRequestPayload {
  [key: string]: unknown;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: 'S256' | null;
  prompt: string | null;
  /** App 發起授權時帶的生物辨識提示（白名單；沒帶或未知值＝null，代表不是新版 App 發起）。 */
  biometric_hint?: BiometricHint | null;
  /** 登入後記下的意圖與設定者；批准時只有同一位使用者才生效。 */
  intent?: BiometricIntent | null;
  intent_user_id?: string | null;
}

export function isAuthRequest(p: unknown): p is AuthRequestPayload {
  const r = p as AuthRequestPayload | undefined;
  return !!r && typeof r.client_id === 'string' && typeof r.redirect_uri === 'string' && Array.isArray(r.scopes);
}

export function buildAuthRequestPayload(
  v: ValidatedRequest,
  opts: { biometricHint: BiometricHint | null },
): AuthRequestPayload {
  return {
    client_id: v.client.client_id,
    redirect_uri: v.redirectUri,
    scopes: v.scopes,
    state: v.state,
    code_challenge: v.codeChallenge,
    code_challenge_method: v.codeChallengeMethod,
    prompt: v.prompt,
    biometric_hint: opts.biometricHint,
  };
}

/** 存一筆授權請求，回傳 id（預設隨機 32 bytes、TTL 10 分鐘；id／ttlSec 供測試固定）。 */
export async function createAuthRequest(db: D1Database, payload: AuthRequestPayload, opts: { id?: string; ttlSec?: number } = {}): Promise<string> {
  const id = opts.id ?? generateOpaqueToken(32);
  await new D1Adapter(db, NAME).upsert(id, payload, opts.ttlSec ?? AUTH_REQUEST_TTL_SEC);
  return id;
}

/** 讀取但不消耗；不存在、過期或形狀不對 → undefined。 */
export async function peekAuthRequest(db: D1Database, id: string): Promise<{ payload: AuthRequestPayload; expiresAt: number } | undefined> {
  const stored = await new D1Adapter(db, NAME).findWithExpiry(id);
  return stored && isAuthRequest(stored.payload) ? { payload: stored.payload, expiresAt: stored.expiresAt } : undefined;
}

export type SetIntentResult = 'ok' | 'invalid_intent' | 'gone';

/** 記下（null＝清掉）意圖與設定者。檢查順序：值是否白名單 → 請求是否仍有效。 */
export async function setAuthRequestIntent(db: D1Database, id: string, intent: unknown, userId: string): Promise<SetIntentResult> {
  if (intent !== null && !isBiometricIntent(intent)) return 'invalid_intent';
  const res = await db
    .prepare("UPDATE oauth_models SET payload = json_set(payload, '$.intent', ?, '$.intent_user_id', ?) WHERE name = ? AND id = ? AND expires_at >= ?")
    .bind(intent, intent === null ? null : userId, NAME, id, Date.now())
    .run();
  return (res.meta?.changes ?? 0) === 1 ? 'ok' : 'gone';
}

/** 單次使用的領取：只有一個呼叫者能拿到 payload（過期視為不存在）。 */
export async function takeAuthRequest(db: D1Database, id: string): Promise<AuthRequestPayload | undefined> {
  if (!id) return undefined;
  const found = await new D1Adapter(db, NAME).find(id);
  if (!found) return undefined;
  const res = await db
    .prepare('DELETE FROM oauth_models WHERE name = ? AND id = ? AND expires_at >= ?')
    .bind(NAME, id, Date.now())
    .run();
  return (res.meta?.changes ?? 0) === 1 && isAuthRequest(found) ? found : undefined;
}
