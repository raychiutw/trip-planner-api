import type { AuthData } from './types';
export type { AuthData } from './types';

/** Worker 的 bindings 與設定。欄位由舊入口（functions/api/_types.ts）移植，隨各票接上才補齊。 */
export interface Env {
  DB: D1Database;
  /** 逗號分隔的 client_id；名單內的 client 申請 token 時必須帶 DPoP proof。 */
  DPOP_REQUIRED_CLIENTS?: string;
  /** 逗號分隔的 web origin 白名單（精確比對）。未設 = 拒絕所有帶 Origin 的跨站請求。 */
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: 'production' | 'preview' | 'development';
  GOOGLE_MAPS_API_KEY?: string;
  // —— 以下欄位自舊入口 functions/api/_types.ts 移植（各 handler 用到時才需要設定）——
  /** @deprecated Cloudflare Access 已拆除；保留型別以相容舊程式碼。 */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ACCESS_APP_ID?: string;
  CF_ACCESS_POLICY_ID?: string;
  /** 取代 request.url.origin 組 email 連結／OIDC issuer（防 Host header 偽造）。 */
  PUBLIC_ORIGIN?: string;
  /** web 的 origin：授權流程把使用者導向 `${WEB_ORIGIN}/oauth/authorize`；缺省用 PUBLIC_ORIGIN。 */
  WEB_ORIGIN?: string;
  DEV_MOCK_EMAIL?: string;
  /** auth_audit_log／session 的 IP 雜湊用 HMAC key。 */
  OAUTH_SIGNING_PRIVATE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GOOGLE_CLOUD_PROJECT_ID?: string;
  GOOGLE_CLOUD_SA_KEY?: string;
  /** companion gate 鎖定的 OAuth client_id（tp-request）。 */
  TP_REQUEST_CLIENT_ID?: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  /** api → agent HMAC 簽章 key（T17）；三種用途各一把，互不通用。輪替時 api 端只放新 key。 */
  AGENT_SIGNING_KEY_TRIGGER?: string;
  AGENT_SIGNING_KEY_MAIL?: string;
  AGENT_SIGNING_KEY_MINT?: string;
  /** session / invitation token 簽章用的 secret（HKDF 衍生子金鑰）。 */
  SESSION_SECRET?: string;
  /** auth_audit_log 的 IP 雜湊用 HMAC key（未設則退回無鹽 SHA-256）。 */
  SESSION_IP_HASH_SECRET?: string;
  /** 寄信走 mac mini mailer：URL 與 Bearer token（src/lib/email.ts 的 EmailEnv）。 */
  TRIPLINE_API_URL?: string;
  TRIPLINE_API_SECRET?: string;
}

/** Hono 的型別參數：bindings 加上 middleware 掛在 context 的變數。 */
export type AppEnv = { Bindings: Env; Variables: { requestId: string; auth?: AuthData | null; accessToken?: string } };
