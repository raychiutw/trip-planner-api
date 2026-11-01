/**
 * POST /api/oauth/revoke — RFC 7009 Token Revocation
 *
 * V2-P5 — Public OAuth Server endpoint。對齊 OIDC discovery doc
 * `revocation_endpoint` 公告。
 *
 * Body (form-urlencoded):
 *   token=<token-string>
 *   token_type_hint=<access_token | refresh_token>  (optional)
 *   client_id=<client_id>                           (or HTTP Basic auth)
 *   client_secret=<for confidential>                (or HTTP Basic auth)
 *
 * Per RFC 7009 §2.2 — endpoint **always** responds 200 even when token
 * unknown / already revoked / wrong client. 不洩漏 token 是否存在 prevent
 * scanning attack。
 *
 * Authentication required for confidential clients (per RFC 7009 §2.1)：
 *   - client_secret 驗證跟 /token 同邏輯（Basic auth or body）
 *   - client_id 對 token 不一致 → silent 200（不洩 token 屬於別 client）
 *
 * Response: 200 (empty body)
 */
import { D1Adapter, type AdapterPayload } from '../../../lib/oauth-d1-adapter';
import { verifyPassword } from '../../../lib/password';
import { parseFormOrJson, parseBasicAuth } from '../../../lib/utils';
import {
  checkRateLimit,
  bumpRateLimit,
  clientIp,
  RATE_LIMITS,
} from '../../../lib/rate-limit';
import { oauthErrorResponse, buildRateLimitResponse } from '../../../errors';
import type { Env } from '../../../env';

interface ClientAppRow {
  client_id: string;
  client_type: 'public' | 'confidential';
  client_secret_hash: string | null;
  status: string;
}

interface AccessTokenPayload extends AdapterPayload {
  client_id: string;
  user_id: string;
  scopes: string[];
  grantId: string;
}

interface RefreshTokenPayload extends AdapterPayload {
  client_id: string;
  user_id: string;
  scopes: string[];
  grantId: string;
}

function silent200(): Response {
  // RFC 7009 §2.2: server responds with HTTP status 200 if token is invalid /
  // expired / already revoked. 不洩 token 存在性。本 helper 保留為自建 — return
  // 200 empty body 不適用 oauthErrorResponse 的 error JSON shape。
  return new Response(null, {
    status: 200,
    headers: { 'cache-control': 'no-store', 'pragma': 'no-cache' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const body = await parseFormOrJson<Record<string, string>>(context.request);
  const token = body.token;
  // Per RFC 7009 §2.1: missing token = invalid_request (only error case)
  if (!token) {
    return oauthErrorResponse('invalid_request', 'Missing token parameter');
  }

  const basic = parseBasicAuth(context.request);
  const clientId = basic?.id ?? body.client_id;
  const clientSecret = basic?.secret ?? body.client_secret;
  if (!clientId) {
    return oauthErrorResponse('invalid_client', 'Missing client_id', 401);
  }

  // v2.33.103 SEC-7: per-IP rate-limit 在 PBKDF2 verify 前。Confidential client
  // verifyPassword 100k iter ~50ms CPU；attacker 反覆送 wrong secret → CPU DoS。
  // Bump 在 IP check pass 後即發，與 token endpoint 共用同個 preset 但不同 bucket。
  const ipKey = `oauth-revoke:ip:${clientIp(context.request)}`;
  const ipCheck = await checkRateLimit(context.env.DB, ipKey, RATE_LIMITS.OAUTH_TOKEN_PER_IP);
  if (!ipCheck.ok) {
    return buildRateLimitResponse(ipCheck.retryAfter ?? 60, {
      error: 'rate_limited',
      error_description: 'Too many revoke requests from this IP',
    });
  }
  await bumpRateLimit(context.env.DB, ipKey, RATE_LIMITS.OAUTH_TOKEN_PER_IP);

  const client = await context.env.DB
    .prepare(
      `SELECT client_id, client_type, client_secret_hash, status
       FROM client_apps WHERE client_id = ?`,
    )
    .bind(clientId)
    .first<ClientAppRow>();

  if (!client || client.status !== 'active') {
    return oauthErrorResponse('invalid_client', 'Unknown or inactive client_id', 401);
  }

  if (client.client_type === 'confidential') {
    if (!clientSecret || !client.client_secret_hash) {
      return oauthErrorResponse('invalid_client', 'client_secret required for confidential client', 401);
    }
    const ok = await verifyPassword(clientSecret, client.client_secret_hash);
    if (!ok) return oauthErrorResponse('invalid_client', 'Invalid client_secret', 401);
  }

  // Try access_token first, then refresh_token (token_type_hint speeds the lookup
  // but per RFC 7009 §4.1.2 we MUST try the other if the hint misses)。
  const hint = body.token_type_hint;
  const tryOrder = hint === 'refresh_token' ? ['RefreshToken', 'AccessToken'] : ['AccessToken', 'RefreshToken'];

  for (const adapterName of tryOrder) {
    const adapter = new D1Adapter(context.env.DB, adapterName);
    const payload = (await adapter.find(token)) as AccessTokenPayload | RefreshTokenPayload | undefined;
    if (!payload) continue;

    // RFC 7009: token belongs to wrong client → silent 200, don't leak
    if (payload.client_id !== clientId) {
      return silent200();
    }

    // Revoke this token
    await adapter.destroy(token);

    // RFC 7009 §2.1: revoking a refresh_token MUST also revoke all access_tokens
    // issued by this grant chain
    if (adapterName === 'RefreshToken' && payload.grantId) {
      await adapter.revokeByGrantId(payload.grantId);
    }
    return silent200();
  }

  // Token not found in either store — silent 200 (RFC 7009 §2.2)
  return silent200();
};
