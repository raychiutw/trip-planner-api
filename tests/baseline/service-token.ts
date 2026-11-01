/**
 * client_credentials 式的 service token：user_id 為 null，scope 由呼叫端指定（例如 ops:poi）。
 * 與 http.ts 的 tokenFor（使用者綁定 token）互補，寫入真實的 AccessToken 資料列。
 */
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

export async function serviceToken(db: D1Database, scopes: string[], clientId = 'http-test-service'): Promise<string> {
  const token = `http-test-service-${crypto.randomUUID()}`;
  await new D1Adapter(db, 'AccessToken').upsert(
    token,
    { jti: token, client_id: clientId, user_id: null, scopes, grantId: `grant-${token}` },
    300,
  );
  return token;
}

/** 具名參數版本（middleware、companion 與行程筆記測試使用），內部沿用 serviceToken。 */
export function serviceTokenFor(db: D1Database, opts: { clientId: string; scopes: string[] }): Promise<string> {
  return serviceToken(db, opts.scopes, opts.clientId);
}
