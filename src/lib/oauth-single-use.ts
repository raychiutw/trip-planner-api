/**
 * oauth_models 的「單次使用」領取：只有一個呼叫者能拿到 payload。
 * 先 find（過期視為不存在），再以條件式 DELETE 搶佔——只有 changes === 1 的贏家回傳 payload，
 * 平行重送、重放一律拿到 undefined。
 */
import { D1Adapter, type AdapterPayload } from './oauth-d1-adapter';

export async function takeOnce(db: D1Database, name: string, id: string): Promise<AdapterPayload | undefined> {
  if (!id) return undefined;
  const found = await new D1Adapter(db, name).find(id);
  if (!found) return undefined;
  const res = await db
    .prepare('DELETE FROM oauth_models WHERE name = ? AND id = ? AND expires_at >= ?')
    .bind(name, id, Date.now())
    .run();
  return (res.meta?.changes ?? 0) === 1 ? found : undefined;
}

/** 把 code／error／state（與 server 決定的 biometric_intent）加到 redirect_uri 的 query（原有的 code／error 先清掉，其餘 query 保留）。 */
export function buildClientRedirect(
  redirectUri: string,
  params: { code?: string; error?: string; errorDescription?: string; state?: string | null; biometricIntent?: 'enable' | 'disable' },
): string {
  const url = new URL(redirectUri);
  url.searchParams.delete('code');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  url.searchParams.delete('state');
  url.searchParams.delete('biometric_intent');
  if (params.code) url.searchParams.set('code', params.code);
  if (params.error) url.searchParams.set('error', params.error);
  if (params.errorDescription) url.searchParams.set('error_description', params.errorDescription);
  if (params.state) url.searchParams.set('state', params.state);
  if (params.biometricIntent) url.searchParams.set('biometric_intent', params.biometricIntent);
  return url.toString();
}
