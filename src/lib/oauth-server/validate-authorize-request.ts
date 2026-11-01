/**
 * OAuth Server `/authorize` request validator — V2-P4
 *
 * Pure module — caller (functions/api/oauth/authorize.ts，V2-P5 routing fix)
 * 用此驗 incoming authorize request from external OAuth client。
 *
 * Per RFC 6749 §4.1.1（authorization_code grant）：
 *   - response_type=code (only — no implicit/hybrid)
 *   - client_id required，必須在 client_apps + active
 *   - redirect_uri must EXACT match client_apps.redirect_uris (no prefix / wildcard)
 *   - scope subset of client_apps.allowed_scopes
 *   - state recommended (anti-CSRF — 不強制但 warn)
 *   - PKCE required for public clients (code_challenge + code_challenge_method=S256)
 *   - PKCE optional for confidential clients (V2-P6 enforce always)
 */

export interface ClientAppRow {
  client_id: string;
  client_type: 'public' | 'confidential';
  app_name: string;
  redirect_uris: string;     // JSON array
  allowed_scopes: string;    // JSON array
  status: 'active' | 'suspended' | 'pending_review';
}

export interface AuthorizeRequest {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  prompt?: string;
}

export interface ValidationError {
  code: string;
  message: string;
  /** RFC 6749 spec：error 應 redirect 回 client redirect_uri (除非 redirect_uri 本身 invalid) */
  redirectableToClient: boolean;
}

export interface ValidatedRequest {
  client: ClientAppRow;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: 'S256' | null;
  prompt: string | null;
}

function safeParseArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Validate authorize request against client_apps row。
 *
 * @returns ValidatedRequest on success, ValidationError on fail
 */
export function validateAuthorizeRequest(
  req: AuthorizeRequest,
  client: ClientAppRow | null,
): ValidatedRequest | ValidationError {
  // 1. client_id check (must be in DB)
  if (!req.client_id) {
    return { code: 'invalid_request', message: 'Missing client_id', redirectableToClient: false };
  }
  if (!client) {
    return { code: 'unauthorized_client', message: 'Unknown client_id', redirectableToClient: false };
  }
  if (client.status !== 'active') {
    return {
      code: 'unauthorized_client',
      message: `Client status: ${client.status}（須 active）`,
      redirectableToClient: false,
    };
  }

  // 2. redirect_uri exact match
  if (!req.redirect_uri) {
    return { code: 'invalid_request', message: 'Missing redirect_uri', redirectableToClient: false };
  }
  const allowedRedirects = safeParseArray(client.redirect_uris);
  if (!allowedRedirects.includes(req.redirect_uri)) {
    return {
      code: 'invalid_request',
      message: 'redirect_uri 不在 client whitelist（exact match required）',
      redirectableToClient: false,
    };
  }

  // 3. response_type
  if (req.response_type !== 'code') {
    return {
      code: 'unsupported_response_type',
      message: 'Only response_type=code supported (V2-P4)',
      redirectableToClient: true,
    };
  }

  // 4. scope subset of allowed_scopes
  const allowedScopes = safeParseArray(client.allowed_scopes);
  const requestedScopes = (req.scope ?? '').split(/\s+/).filter(Boolean);
  if (requestedScopes.length === 0) {
    return {
      code: 'invalid_scope',
      message: 'scope must contain at least one value',
      redirectableToClient: true,
    };
  }
  const invalidScopes = requestedScopes.filter((s) => !allowedScopes.includes(s));
  if (invalidScopes.length > 0) {
    return {
      code: 'invalid_scope',
      message: `Scopes not allowed for this client: ${invalidScopes.join(', ')}`,
      redirectableToClient: true,
    };
  }

  // 5. PKCE mandatory for all clients (v2.33.59 round 13: OAuth 2.1 baseline)
  // Previously confidential clients could skip PKCE; per OAuth 2.1 §4.1.1 PKCE
  // gives meaningful defense against authorization-code interception even with
  // client_secret (MITM / malicious extension / address-bar snoop)。
  if (!req.code_challenge) {
    return {
      code: 'invalid_request',
      message: 'PKCE code_challenge required (OAuth 2.1 baseline)',
      redirectableToClient: true,
    };
  }
  if (req.code_challenge_method !== 'S256') {
    return {
      code: 'invalid_request',
      message: 'PKCE code_challenge_method must be S256 (plain not supported)',
      redirectableToClient: true,
    };
  }

  // 6. prompt validation (optional)
  const validPrompts = ['none', 'login', 'consent', 'select_account'];
  if (req.prompt && !validPrompts.includes(req.prompt)) {
    return {
      code: 'invalid_request',
      message: `prompt must be one of: ${validPrompts.join(', ')}`,
      redirectableToClient: true,
    };
  }

  return {
    client,
    redirectUri: req.redirect_uri,
    scopes: requestedScopes,
    state: req.state ?? null,
    codeChallenge: req.code_challenge ?? null,
    codeChallengeMethod: 'S256',
    prompt: req.prompt ?? null,
  };
}
