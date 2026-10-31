import type { AuthData } from './types';

/** Worker 的 bindings 與設定。欄位由舊入口（functions/api/_types.ts）移植，隨各票接上才補齊。 */
export interface Env {
  DB: D1Database;
  /** 逗號分隔的 web origin 白名單（精確比對）。未設 = 拒絕所有帶 Origin 的跨站請求。 */
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: 'production' | 'preview' | 'development';
  GOOGLE_MAPS_API_KEY?: string;
  /** api → agent HMAC 簽章 key（T17）；三種用途各一把，互不通用。輪替時 api 端只放新 key。 */
  AGENT_SIGNING_KEY_TRIGGER?: string;
  AGENT_SIGNING_KEY_MAIL?: string;
  AGENT_SIGNING_KEY_MINT?: string;
  /** session / invitation token 簽章用的 secret（HKDF 衍生子金鑰）。 */
  SESSION_SECRET?: string;
  /** 寄信走 mac mini mailer：URL 與 Bearer token（src/lib/email.ts 的 EmailEnv）。 */
  TRIPLINE_API_URL?: string;
  TRIPLINE_API_SECRET?: string;
}

/** Hono 的型別參數：bindings 加上 middleware 掛在 context 的變數。 */
export type AppEnv = { Bindings: Env; Variables: { requestId: string; auth?: AuthData | null; accessToken?: string } };
