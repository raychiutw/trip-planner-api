/**
 * POST /api/oauth/token — RFC 6749 token endpoint（拆分 T9）。
 * grant：authorization_code(+PKCE)、refresh_token（輪替＋reuse 偵測）、client_credentials。
 * 錯誤用 RFC 6749 §5.2 扁平形狀。沒有 password grant。
 *
 * 順序刻意：per-IP rate limit 最先（便宜地擋掉 PBKDF2 放大攻擊與垃圾請求）→ 解析 → grant／client 檢查 →
 * 確認 client 存在後才計 per-client 配額（未知 client 不寫 DB）→ confidential 驗 secret。
 */
import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { buildRateLimitResponse, oauthErrorResponse } from '../errors';
import { recordAuthEvent } from '../lib/auth-audit';
import { generateOpaqueToken } from '../lib/crypto';
import { readDpopHeader, verifyDpopProof } from '../lib/dpop';
import { D1Adapter } from '../lib/oauth-d1-adapter';
import { verifyPassword } from '../lib/password';
import { bumpRateLimit, checkRateLimit, clientIp, RATE_LIMITS } from '../lib/rate-limit';
import { ACCESS_TOKEN_TTL_SEC, exchangeAuthorizationCode, rotateRefreshToken } from '../lib/token-lifecycle';

const MAX_BODY_BYTES = 16 * 1024;

interface ClientAppRow {
  client_id: string;
  client_type: 'public' | 'confidential';
  client_secret_hash: string | null;
  status: string;
  allowed_scopes: string;
}

const NO_STORE = { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' };

/** OAuth 錯誤一律不可快取。 */
function oauthError(error: string, description: string, status = 400): Response {
  const res = oauthErrorResponse(error, description, status);
  res.headers.set('pragma', 'no-cache');
  return res;
}

async function parseBody(request: Request): Promise<Record<string, string> | null> {
  const ct = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    if (ct.includes('application/json')) {
      const v: unknown = JSON.parse(text);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
      return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
    }
  } catch {
    return null;
  }
  return {};
}

function parseBasic(request: Request): { id: string; secret: string } | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !/^Basic /i.test(auth)) return null;
  try {
    const decoded = atob(auth.slice(6));
    const i = decoded.indexOf(':');
    return i < 0 ? null : { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

function tokenJson(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { headers: NO_STORE });
}

function parseScopes(raw: string | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

export function registerTokenRoute(app: Hono<AppEnv>): void {
  app.post('/api/oauth/token', async (c) => {
    const { DB } = c.env;
    const request = c.req.raw;

    const ipKey = `oauth-token:ip:${clientIp(request)}`;
    const ipCheck = await checkRateLimit(DB, ipKey, RATE_LIMITS.OAUTH_TOKEN_PER_IP);
    if (!ipCheck.ok) {
      return buildRateLimitResponse(ipCheck.retryAfter ?? 60, { error: 'rate_limited', error_description: 'Too many token requests from this IP' });
    }
    await bumpRateLimit(DB, ipKey, RATE_LIMITS.OAUTH_TOKEN_PER_IP);

    const body = await parseBody(request);
    if (!body) return oauthError('invalid_request', 'Malformed or oversized request body');

    const grantType = body.grant_type;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token' && grantType !== 'client_credentials') {
      return oauthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token, client_credentials');
    }

    const basic = parseBasic(request);
    const clientId = basic?.id ?? body.client_id;
    const clientSecret = basic?.secret ?? body.client_secret;
    if (!clientId) return oauthError('invalid_client', 'Missing client_id');

    const client = await DB.prepare(
      'SELECT client_id, client_type, client_secret_hash, status, allowed_scopes FROM client_apps WHERE client_id = ?',
    ).bind(clientId).first<ClientAppRow>();
    if (!client || client.status !== 'active') return oauthError('invalid_client', 'Unknown or inactive client_id', 401);

    const clientKey = `oauth-token:${clientId}`;
    const clientCheck = await checkRateLimit(DB, clientKey, RATE_LIMITS.OAUTH_TOKEN);
    if (!clientCheck.ok) {
      return buildRateLimitResponse(clientCheck.retryAfter ?? 60, { error: 'rate_limited', error_description: 'Too many token requests for this client' });
    }
    await bumpRateLimit(DB, clientKey, RATE_LIMITS.OAUTH_TOKEN);

    if (client.client_type === 'confidential') {
      if (!clientSecret || !client.client_secret_hash) return oauthError('invalid_client', 'client_secret required for confidential client', 401);
      if (!(await verifyPassword(clientSecret, client.client_secret_hash))) return oauthError('invalid_client', 'Invalid client_secret', 401);
    }

    // DPoP（client 身分確認後才驗，避免密碼錯誤的請求寫入 jti）：帶了 proof 就必須有效（驗證通過才綁定）；client 在強制名單則一定要帶
    let dpopJkt: string | undefined;
    const required = (c.env.DPOP_REQUIRED_CLIENTS ?? '').split(',').map((x) => x.trim()).filter(Boolean).includes(clientId);
    if (readDpopHeader(request) !== null || required) {
      const dpop = await verifyDpopProof(request, DB);
      if (!dpop.ok) return oauthError('invalid_dpop_proof', 'Invalid or missing DPoP proof');
      dpopJkt = dpop.jkt;
    }

    if (grantType === 'client_credentials') {
      if (client.client_type !== 'confidential') {
        return oauthError('unauthorized_client', 'client_credentials grant requires a confidential client', 401);
      }
      let allowed: string[] = [];
      try {
        const parsed: unknown = JSON.parse(client.allowed_scopes ?? '[]');
        if (Array.isArray(parsed)) allowed = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* 壞掉 → 空白名單（拒絕） */ }
      const requested = parseScopes(body.scope);
      const finalScopes = requested.length === 0 ? allowed : requested;
      const invalid = finalScopes.filter((s) => !allowed.includes(s));
      if (invalid.length > 0) return oauthError('invalid_scope', `Scope not permitted for this client: ${invalid.join(', ')}`);

      // 只發 access token，不發 refresh token（RFC 6749 §4.4.3）
      const accessToken = generateOpaqueToken(48);
      await new D1Adapter(DB, 'AccessToken').upsert(
        accessToken,
        { client_id: clientId, user_id: null, scopes: finalScopes, grantId: crypto.randomUUID(), ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}) },
        ACCESS_TOKEN_TTL_SEC,
      );
      await recordAuthEvent(DB, request, {
        eventType: 'token_issue', outcome: 'success', userId: null, clientId,
        metadata: { grant_type: 'client_credentials', scopes: finalScopes },
      }, c.env);
      return tokenJson({ access_token: accessToken, token_type: dpopJkt ? 'DPoP' : 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, scope: finalScopes.join(' ') });
    }

    const result = grantType === 'refresh_token'
      ? await rotateRefreshToken(c.env, request, clientId, body, { dpopJkt })
      : await exchangeAuthorizationCode(c.env, request, clientId, body, { requirePkce: client.client_type === 'public', dpopJkt });
    if (!result.ok) return oauthError(result.error, result.description);
    return tokenJson({
      access_token: result.tokens.access_token,
      refresh_token: result.tokens.refresh_token,
      token_type: dpopJkt ? 'DPoP' : 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      scope: result.scopes.join(' '),
    });
  });
}
