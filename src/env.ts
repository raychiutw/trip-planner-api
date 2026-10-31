export interface Env {
  DB: D1Database;
  GOOGLE_MAPS_API_KEY?: string;
  /** api → agent HMAC 簽章 key（T17）；三種用途各一把，互不通用。輪替時 api 端只放新 key。 */
  AGENT_SIGNING_KEY_TRIGGER?: string;
  AGENT_SIGNING_KEY_MAIL?: string;
  AGENT_SIGNING_KEY_MINT?: string;
}
