/** 重新驗證的「剛用密碼登入」檢查；簽發端與 TTL／redirect_uri 約定見 oauth-contract 的 LOGIN_CODE_*。 */

/**
 * 這個 bearer 是否「剛用密碼登入」得到的：/api/oauth/login 簽的 code（redirect_uri 為 null、TTL 為 LOGIN_CODE_TTL_SEC）
 * 在換成 token 後仍留在 oauth_models 到期，且 grantId 與 bearer 相同。refresh 還原的登入沿用舊 grantId，
 * 而該 code 早已過期被清，所以還原的舊登入通過不了。不需要 schema 變更。
 * 限制：登入後 LOGIN_CODE_TTL_SEC 秒內才能批准；超過要重新輸入密碼。
 */
export async function isFreshPasswordLogin(db: D1Database, grantId: string | undefined): Promise<boolean> {
  if (!grantId) return false;
  // SQL 的 IS NULL 對應 LOGIN_CODE_REDIRECT_URI（null）；由 tests/oauth-contract.test.ts 守門
  const row = await db
    .prepare("SELECT 1 AS x FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.grantId') = ? AND json_extract(payload, '$.redirect_uri') IS NULL AND expires_at >= ?")
    .bind(grantId, Date.now())
    .first();
  return !!row;
}
