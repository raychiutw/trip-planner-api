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
import { MOBILE_GATE_MESSAGE, mobileClientAllowed } from '../lib/mobile-oauth';
import { recordAuthEvent } from '../lib/auth-audit';
import { generateOpaqueToken } from '../lib/crypto';
import { checkDpopProof, readDpopHeader, registerDpopJti } from '../lib/dpop';
import { classifyDpopFailure, recordSecurityEvent } from '../lib/security-events';
import { issueIdToken } from './handlers/oauth/_id_token';
import { D1Adapter } from '../lib/oauth-d1-adapter';
import { parseAllowedScopes, readBodyText } from '../lib/oauth-request';
import { verifyPassword } from '../lib/password';
import { bucketSelect, bumpRateLimit, clientIp, evaluateBucket, RATE_LIMITS } from '../lib/rate-limit';
import { SERVICE_ACCESS_TOKEN_TTL_SEC, USER_ACCESS_TOKEN_TTL_SEC, exchangeAuthorizationCode, rotateRefreshToken } from '../lib/token-lifecycle';

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
  const text = await readBodyText(request);
  if (text === null) return null;
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
    // 限流計數寫入與其餘流程並行（不排在關鍵路徑上），但一定在回應前完成（不弱化限流）；
    // 非關鍵的成功稽核走 waitUntil（沒有 executionCtx 的測試環境就地等完，行為與先前一致）。
    const bumps: Promise<unknown>[] = [];
    const deferred: Promise<unknown>[] = [];
    const track = <T,>(p: Promise<T>): Promise<T> => { p.catch(() => {}); bumps.push(p); return p; };
    const defer = (work: () => Promise<unknown>) => {
      const p = work().catch(() => {});
      try { c.executionCtx.waitUntil(p); } catch { deferred.push(p); }
    };
    try {
      const res = await handleToken(c, track, defer);
      await Promise.all(bumps);
      return res;
    } catch (e) {
      await Promise.allSettled(bumps);
      throw e;
    } finally {
      await Promise.allSettled(deferred);
    }
  });
}

type Ctx = import('hono').Context<AppEnv>;

async function handleToken(c: Ctx, track: <T>(p: Promise<T>) => Promise<T>, defer: (work: () => Promise<unknown>) => void): Promise<Response> {
  {
    const { DB } = c.env;
    const request = c.req.raw;

    const ipKey = `oauth-token:ip:${clientIp(request)}`;
    // body 解析不碰 D1，提前到限流檢查之前，才能把「IP 桶、client、client 桶」三個讀取併成一次往返。
    // 限流檢查的結果仍然最先生效（被鎖的 IP 一律 429，與 body 內容無關）。
    const body = await parseBody(request);
    const grantType = body?.grant_type;
    const grantOk = grantType === 'authorization_code' || grantType === 'refresh_token' || grantType === 'client_credentials';
    const basic = parseBasic(request);
    const clientId = basic?.id ?? body?.client_id;
    const clientSecret = basic?.secret ?? body?.client_secret;
    // mobile client 的環境閘門（自舊入口移植）：client 必須與環境相符；請求若帶 redirect_uri，必須是該環境的精確 callback。
    // 第一方密碼登入發的 code 沒有 redirect_uri、換 token 也不帶：沒帶就不比對（code 自己的 redirect 綁定由下方 authorization_code 流程驗）。
    const gateOk = !!body && grantOk && !!clientId
      && mobileClientAllowed(c.env, request, clientId, grantType === 'authorization_code' ? (body.redirect_uri ?? undefined) : undefined);

    const clientKey = clientId ? `oauth-token:${clientId}` : '';
    const reads = [bucketSelect(DB, ipKey)];
    if (gateOk) {
      reads.push(
        DB.prepare('SELECT client_id, client_type, client_secret_hash, status, allowed_scopes FROM client_apps WHERE client_id = ?').bind(clientId),
        bucketSelect(DB, clientKey),
      );
    }
    const [ipRows, clientRows, clientBucketRows] = (await DB.batch(reads)).map((r) => (r.results ?? []) as never[]);

    const ipCheck = evaluateBucket(ipRows![0], RATE_LIMITS.OAUTH_TOKEN_PER_IP);
    if (!ipCheck.ok) {
      return buildRateLimitResponse(ipCheck.retryAfter ?? 60, { error: 'rate_limited', error_description: 'Too many token requests from this IP' });
    }
    track(bumpRateLimit(DB, ipKey, RATE_LIMITS.OAUTH_TOKEN_PER_IP));

    if (!body) return oauthError('invalid_request', 'Malformed or oversized request body');
    if (!grantOk) {
      return oauthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token, client_credentials');
    }
    if (!clientId) return oauthError('invalid_client', 'Missing client_id');
    if (!gateOk) return oauthError('invalid_client', MOBILE_GATE_MESSAGE);

    const client = clientRows![0] as ClientAppRow | undefined;
    if (!client || client.status !== 'active') return oauthError('invalid_client', 'Unknown or inactive client_id', 401);

    const clientCheck = evaluateBucket(clientBucketRows![0], RATE_LIMITS.OAUTH_TOKEN);
    if (!clientCheck.ok) {
      return buildRateLimitResponse(clientCheck.retryAfter ?? 60, { error: 'rate_limited', error_description: 'Too many token requests for this client' });
    }
    track(bumpRateLimit(DB, clientKey, RATE_LIMITS.OAUTH_TOKEN));

    if (client.client_type === 'confidential') {
      if (!clientSecret || !client.client_secret_hash) return oauthError('invalid_client', 'client_secret required for confidential client', 401);
      if (!(await verifyPassword(clientSecret, client.client_secret_hash))) return oauthError('invalid_client', 'Invalid client_secret', 401);
    }

    // DPoP（client 身分確認後才驗，避免密碼錯誤的請求寫入 jti）：帶了 proof 就必須有效（驗證通過才綁定）；client 在強制名單則一定要帶
    let dpopJkt: string | undefined;
    // refresh：jti 登記與讀 refresh token 互不相依，併成一次往返（proof 有效才會登記；讀取本身無副作用）
    let refreshRowPre: { row: Awaited<ReturnType<D1Adapter['find']>> } | undefined;
    const required = (c.env.DPOP_REQUIRED_CLIENTS ?? '').split(',').map((x) => x.trim()).filter(Boolean).includes(clientId);
    if (readDpopHeader(request) !== null || required) {
      const checked = await checkDpopProof(request);
      let failReason = checked.ok ? null : checked.reason;
      if (checked.ok) {
        try {
          const [fresh, row] = await Promise.all([
            registerDpopJti(DB, checked),
            grantType === 'refresh_token' && body.refresh_token ? new D1Adapter(DB, 'RefreshToken').find(body.refresh_token) : Promise.resolve(undefined),
          ]);
          if (!fresh) failReason = 'replay';
          else if (grantType === 'refresh_token') refreshRowPre = { row };
        } catch {
          failReason = 'malformed';
        }
      }
      if (failReason !== null) {
        // 「沒帶 proof 但 client 被強制要求」是設定上的拒絕，不是簽章錯誤；其餘（簽章、欄位、重放）寫稽核並告警
        if (failReason !== 'missing') await recordSecurityEvent(c.env, request, { ...classifyDpopFailure(failReason), clientId });
        return oauthError('invalid_dpop_proof', 'Invalid or missing DPoP proof');
      }
      dpopJkt = (checked as { jkt: string }).jkt;
    }

    if (grantType === 'client_credentials') {
      if (client.client_type !== 'confidential') {
        return oauthError('unauthorized_client', 'client_credentials grant requires a confidential client', 401);
      }
      const allowed = parseAllowedScopes(client.allowed_scopes);
      const requested = parseScopes(body.scope);
      const finalScopes = requested.length === 0 ? allowed : requested;
      const invalid = finalScopes.filter((s) => !allowed.includes(s));
      if (invalid.length > 0) return oauthError('invalid_scope', `Scope not permitted for this client: ${invalid.join(', ')}`);

      // 只發 access token，不發 refresh token（RFC 6749 §4.4.3）
      const accessToken = generateOpaqueToken(48);
      await new D1Adapter(DB, 'AccessToken').upsert(
        accessToken,
        { client_id: clientId, user_id: null, scopes: finalScopes, grantId: crypto.randomUUID(), ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}) },
        SERVICE_ACCESS_TOKEN_TTL_SEC,
      );
      await recordAuthEvent(DB, request, {
        eventType: 'token_issue', outcome: 'success', userId: null, clientId,
        metadata: { grant_type: 'client_credentials', scopes: finalScopes },
      }, c.env);
      return tokenJson({ access_token: accessToken, token_type: dpopJkt ? 'DPoP' : 'Bearer', expires_in: SERVICE_ACCESS_TOKEN_TTL_SEC, scope: finalScopes.join(' ') });
    }

    const result = grantType === 'refresh_token'
      ? await rotateRefreshToken(c.env, request, clientId, body, { dpopJkt, defer, ...(refreshRowPre ? { refreshRow: refreshRowPre.row } : {}) })
      : await exchangeAuthorizationCode(c.env, request, clientId, body, { requirePkce: client.client_type === 'public', dpopJkt, defer });
    if (!result.ok) return oauthError(result.error, result.description);

    // OIDC id_token：scope 含 openid 且有設定簽章 key 才簽；簽不出來（沒設 key、key 壞掉、使用者不見）
    // 不能讓整個 token 請求失敗——access／refresh token 已經發出，client 沒有 id_token 仍可運作。
    let idToken: string | null = null;
    try {
      idToken = await issueIdToken(c.env, request, clientId, result.userId, result.scopes);
    } catch {
      idToken = null;
    }
    return tokenJson({
      access_token: result.tokens.access_token,
      refresh_token: result.tokens.refresh_token,
      token_type: dpopJkt ? 'DPoP' : 'Bearer',
      expires_in: USER_ACCESS_TOKEN_TTL_SEC,
      scope: result.scopes.join(' '),
      ...(idToken ? { id_token: idToken } : {}),
    });
  }
}
