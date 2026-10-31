/**
 * 第一方 client 識別 —— 單一來源。
 *
 * 這個 id 原本在 `account/ai-authorization.ts:24` 與 `oauth/mint-restricted.ts:37`
 * 各寫死一份。2026-07-20 加 OAuth scope gate 時需要第三處判斷，
 * 三份各自寫死必然漂移，故抽出。
 *
 * ⚠ 刻意**不從 env 讀**。`Env.TP_REQUEST_CLIENT_ID` 是選填且不在 wrangler.toml，
 *   若靠它比對，正式環境沒設就會比到 `undefined` → 第一方豁免永遠不生效 →
 *   AI pipeline 在 downscope 那步被 scope gate 擋死。既有兩處本來就用寫死常數，
 *   對齊它們才是可靠的。env 僅作為可選覆寫（自架 / 測試用）。
 */
export const TP_REQUEST_CLIENT_ID = 'tripline-tp-request';

/** 判定某個 OAuth client_id 是否為第一方（自家 AI pipeline）。 */
export function isFirstPartyClientId(
  clientId: string | undefined | null,
  envOverride?: string,
): boolean {
  if (!clientId) return false;
  return clientId === (envOverride || TP_REQUEST_CLIENT_ID);
}
