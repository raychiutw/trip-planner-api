/** One owner for grant validation, consumption and complete token issuance.
 * HTTP parsing/serialization and optional OIDC signing stay at the protocol entry.
 */
import { D1Adapter, type AdapterPayload } from './oauth-d1-adapter';
import { generateOpaqueToken } from './crypto';
import { recordAuthEvent } from './auth-audit';
import type { Env } from '../env';

export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export type TokenLifecycleResult =
  | { ok: true; tokens: { access_token: string; refresh_token: string }; userId: string; scopes: string[] }
  | { ok: false; error: 'invalid_request' | 'invalid_grant' | 'invalid_scope'; description: string };

function failure(error: 'invalid_request' | 'invalid_grant' | 'invalid_scope', description: string): TokenLifecycleResult {
  return { ok: false, error, description };
}

interface AuthorizationCodePayload extends AdapterPayload {
  client_id: string;
  user_id: string;
  /** 第一方直接登入換的 code 沒有 redirect_uri（null）；跳轉授權的 code 有。 */
  redirect_uri: string | null;
  scopes: string[];
  code_challenge: string | null;
  code_challenge_method: 'S256' | null;
  /** Set to grantId of the issued tokens after consume — enables RFC 6749 §10.5 cascade revoke on replay */
  grantId?: string;
  /** 授權請求時綁定的 DPoP 金鑰指紋（選填）。 */
  dpop_jkt?: string;
}

/** Compute SHA-256 hash of code_verifier and base64url encode (per RFC 7636 §4.6). */
async function pkceTransform(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Issue access+refresh tokens. When the source carries a grantId (rotation),
 * the new pair inherits it so revokeByGrantId can cascade across the entire
 * token family — necessary for RFC 6749 §10.5 / OAuth 2.1 §6.1 reuse detection.
 */
async function issueTokenPair(
  db: Env['DB'],
  clientId: string,
  userId: string,
  scopes: string[],
  source: { model: 'AuthorizationCode' | 'RefreshToken'; id: string; grantId?: string },
  dpopJkt?: string,
): Promise<{ access_token: string; refresh_token: string; grantId: string } | null> {
  const grantId = source.grantId ?? crypto.randomUUID();
  // 48 bytes (~64 char base64url) — RFC 6749 doesn't fix length but 32 bytes
  // ~256 bits of entropy is the de-facto minimum; bump to 48 for headroom.
  const accessToken = generateOpaqueToken(48);
  const refreshToken = generateOpaqueToken(48);

  const stored = await new D1Adapter(db, source.model).storeIssuedPair(
    source.id,
    { client_id: clientId, user_id: userId, scopes, grantId, ...(dpopJkt ? { cnf: { jkt: dpopJkt } } : {}) },
    { id: accessToken, expiresIn: ACCESS_TOKEN_TTL_SEC },
    { id: refreshToken, expiresIn: REFRESH_TOKEN_TTL_SEC },
  );
  if (!stored) return null;

  return { access_token: accessToken, refresh_token: refreshToken, grantId };
}

export async function exchangeAuthorizationCode(
  env: Env, request: Request, clientId: string,
  body: { code?: string; redirect_uri?: string; code_verifier?: string; scope?: string },
  /** public client 一律強制 PKCE（OAuth 2.1）；confidential 沿用「code 有 challenge 才驗」。 */
  opts: { requirePkce: boolean; dpopJkt?: string } = { requirePkce: true },
): Promise<TokenLifecycleResult> {
  const code = body.code;
  if (!code) return failure('invalid_request', 'Missing code');

  const codeAdapter = new D1Adapter(env.DB, 'AuthorizationCode');
  const codeRow = (await codeAdapter.find(code)) as AuthorizationCodePayload | undefined;

  if (!codeRow) {
    return failure('invalid_grant', 'Authorization code expired or invalid');
  }
  // v2.33.97 security: client_id 不對 → reject 不 cascade。否則 leaked auth code
  // 被任意 registered client B 提交即觸發 victim grantId family revoke (DoS)。
  if (codeRow.client_id !== clientId) {
    return failure('invalid_grant', 'code does not belong to this client');
  }
  // null／空字串都表示「沒有 redirect_uri」；兩邊必須一致（第一方 code 不可被帶著 redirect_uri 兌換）
  if ((codeRow.redirect_uri || null) !== (body.redirect_uri || null)) {
    return failure('invalid_grant', 'redirect_uri mismatch');
  }

  // 授權時已綁定金鑰（dpop_jkt）：兌換必須由同一把金鑰簽 proof
  if (typeof codeRow.dpop_jkt === 'string' && codeRow.dpop_jkt !== opts.dpopJkt) {
    return failure('invalid_grant', 'DPoP key does not match the authorization request');
  }
  if (opts.requirePkce && !codeRow.code_challenge) {
    return failure('invalid_grant', 'PKCE required');
  }
  // PKCE verify (if code_challenge was present at authorize)
  if (codeRow.code_challenge) {
    if (!body.code_verifier) {
      return failure('invalid_grant', 'code_verifier required (PKCE)');
    }
    const expectedChallenge = await pkceTransform(body.code_verifier);
    if (expectedChallenge !== codeRow.code_challenge) {
      return failure('invalid_grant', 'code_verifier does not match code_challenge');
    }
  }

  const requestedScopes = (body.scope ?? '').split(/\s+/).filter(Boolean);
  if (requestedScopes.some((scope) => !codeRow.scopes.includes(scope))) {
    return failure('invalid_scope', 'Cannot widen scope');
  }
  // Authorization-code scopes remain fixed at consent; refresh supports downscoping.
  const finalScopes = codeRow.scopes;

  if (codeRow.consumed) {
    // Replay attack — RFC 6749 §10.5: cascade-revoke all tokens issued from this grant
    if (codeRow.grantId) {
      await new D1Adapter(env.DB, 'AccessToken').revokeByGrantId(codeRow.grantId);
    }
    await recordAuthEvent(env.DB, request, {
      eventType: 'token_issue',
      outcome: 'failure',
      userId: codeRow.user_id,
      clientId,
      failureReason: 'auth_code_replay',
      metadata: { grantId: codeRow.grantId ?? null, scopes: codeRow.scopes },
    }, env);
    return failure('invalid_grant', 'Authorization code already used (replay detected — tokens revoked)');
  }

  // v2.33.58 round 12 C4: atomic CAS consume BEFORE issueTokenPair。
  // 之前 unconditional UPDATE，平行 2 個 POST /token 都過 consumed 檢查、都 issue、
  // 都 consume，產生 2 個獨立 grantId。改 conditional UPDATE 後輸的 caller 收到 false
  // 就 abort，避免 double-spend。
  const won = await codeAdapter.consume(code);
  if (!won) {
    // Race lost — 另一個 caller 平行 exchange 同 code，treat 同 replay
    await recordAuthEvent(env.DB, request, {
      eventType: 'token_issue',
      outcome: 'failure',
      userId: codeRow.user_id,
      clientId,
      failureReason: 'auth_code_concurrent_exchange',
      metadata: { scopes: codeRow.scopes },
    }, env);
    return failure('invalid_grant', 'Authorization code concurrent exchange detected');
  }
  // Won the race — issue tokens + bind grantId for replay-revoke。
  const tokens = await issueTokenPair(env.DB, clientId, codeRow.user_id, finalScopes,
    { model: 'AuthorizationCode', id: code }, opts.dpopJkt);
  if (!tokens) return failure('invalid_grant', 'Authorization code no longer available');
  await recordAuthEvent(env.DB, request, {
    eventType: 'token_issue', outcome: 'success', userId: codeRow.user_id, clientId,
    metadata: { grant_type: 'authorization_code', scopes: finalScopes },
  }, env);
  return { ok: true, tokens, userId: codeRow.user_id, scopes: finalScopes };
}

interface RefreshTokenPayload extends AdapterPayload {
  cnf?: { jkt?: string };
  client_id: string;
  user_id: string;
  scopes: string[];
  grantId: string;
  /** Set on rotation (consume) — re-use attempts after this is set trigger family revoke */
  consumed?: number;
}

export async function rotateRefreshToken(
  env: Env, request: Request, clientId: string,
  body: { refresh_token?: string; scope?: string },
  opts: { dpopJkt?: string } = {},
): Promise<TokenLifecycleResult> {
  const refreshTokenInput = body.refresh_token;
  if (!refreshTokenInput) {
    return failure('invalid_request', 'Missing refresh_token');
  }

  const refreshAdapter = new D1Adapter(env.DB, 'RefreshToken');
  const refreshRow = (await refreshAdapter.find(refreshTokenInput)) as RefreshTokenPayload | undefined;

  if (!refreshRow) {
    return failure('invalid_grant', 'refresh_token expired or invalid');
  }

  // v2.33.97 security: client_id 不對 → reject 不 cascade。否則 leaked-once
  // refresh_token 被任意 registered client B 提交即觸發 victim grantId family
  // revoke = permanent DoS handle on victim。先驗 client_id 再驗 consumed。
  if (refreshRow.client_id !== clientId) {
    return failure('invalid_grant', 'refresh_token does not belong to this client');
  }

  // 綁定的 refresh token 必須由同一把金鑰簽 proof（不可降級成 Bearer、也不連坐撤銷：原持有者不受影響）
  const boundJkt = (refreshRow.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (typeof boundJkt === 'string' && boundJkt !== opts.dpopJkt) {
    return failure('invalid_grant', 'DPoP proof required for this refresh_token');
  }

  // Optional scope downgrade: caller can request narrower scope
  const requestedScopes = (body.scope ?? '').split(/\s+/).filter(Boolean);
  let finalScopes = refreshRow.scopes;
  if (requestedScopes.length > 0) {
    const invalid = requestedScopes.filter((s) => !refreshRow.scopes.includes(s));
    if (invalid.length > 0) {
      return failure('invalid_scope', `Cannot widen scope: ${invalid.join(', ')}`);
    }
    finalScopes = requestedScopes;
  }

  // Reuse detection (RFC 6749 §10.4 / OAuth 2.1 §6.1): if this row was already
  // consumed by a prior rotation, the refresh token has been replayed →
  // attacker likely has a stolen token. Cascade-revoke the entire family.
  if (refreshRow.consumed) {
    await new D1Adapter(env.DB, 'AccessToken').revokeByGrantId(refreshRow.grantId);
    await recordAuthEvent(env.DB, request, {
      eventType: 'token_revoke',
      outcome: 'failure',
      userId: refreshRow.user_id,
      clientId,
      failureReason: 'refresh_token_reuse',
      metadata: { grantId: refreshRow.grantId },
    }, env);
    return failure('invalid_grant', 'refresh_token reuse detected — token family revoked');
  }

  // v2.33.58 round 12 C4: 改 atomic CAS consume — 之前先 issue 再 consume，平行
  // POST /token 兩個都過 .consumed 檢查、都 issue、都 consume，refresh family
  // 分裂。現在先 atomic consume(returns boolean)，輸的 caller 收到 false 就 abort
  // + revoke family (race lost = 雙重 rotation 試圖)。
  const won = await refreshAdapter.consume(refreshTokenInput);
  if (!won) {
    // Race lost — 另一個 caller 同時 rotation 已贏走，cascade revoke 保護
    await new D1Adapter(env.DB, 'AccessToken').revokeByGrantId(refreshRow.grantId);
    await recordAuthEvent(env.DB, request, {
      eventType: 'token_revoke',
      outcome: 'failure',
      userId: refreshRow.user_id,
      clientId,
      failureReason: 'refresh_token_concurrent_rotation',
      metadata: { grantId: refreshRow.grantId },
    }, env);
    return failure('invalid_grant', 'refresh_token concurrent rotation detected — token family revoked');
  }
  const tokens = await issueTokenPair(
    env.DB,
    clientId,
    refreshRow.user_id,
    finalScopes,
    { model: 'RefreshToken', id: refreshTokenInput, grantId: refreshRow.grantId },
    opts.dpopJkt,
  );
  if (!tokens) return failure('invalid_grant', 'refresh_token no longer available');
  await recordAuthEvent(env.DB, request, {
    eventType: 'token_issue',
    outcome: 'success',
    userId: refreshRow.user_id,
    clientId,
    metadata: { grant_type: 'refresh_token', scopes: finalScopes },
  }, env);
  return { ok: true, tokens, userId: refreshRow.user_id, scopes: finalScopes };
}
