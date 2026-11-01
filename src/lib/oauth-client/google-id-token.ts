/**
 * Google id_token verification — V2-P5 critical security fix
 *
 * Per OpenID Connect Core §3.1.3.7, a relying party MUST verify the id_token
 * signature against the issuer's published JWKS, plus iss / aud / exp claims.
 * The earlier "trust HTTPS endpoint" shortcut leaves an account-takeover hole
 * if the token is delivered via a misconfigured proxy or auth-flow bug.
 *
 * Reference: https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
 */

import { verifyJwt, decodeJwtHeader, importPublicJwk, type JwtClaims } from '../jwt';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
// Both forms appear in Google id_tokens. Spec-compliant verifiers accept either.
const ALLOWED_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

interface GoogleJwks {
  keys: Array<JsonWebKey & { kid?: string }>;
}

/**
 * In-isolate JWKS cache. Google rotates keys ~daily; 1h TTL is conservative.
 *
 * v2.33.63 round 14d: 已知 limitation — 每個 CF Worker isolate 各自 cache，
 * key rotation 時不同 isolate 可能短暫服務不同 JWKS (max gap ~1h)。retry-on-miss
 * path (line 59-64) 已處理 transient miss。長期改 KV cache 達到 cross-isolate
 * consistency 需 V2-P7 infra (binding + cron warmer)，目前風險可接受。
 */
let jwksCache: { fetchedAt: number; jwks: GoogleJwks } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchGoogleJwks(): Promise<GoogleJwks> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.jwks;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS: ${res.status}`);
  }
  const jwks = (await res.json()) as GoogleJwks;
  jwksCache = { fetchedAt: Date.now(), jwks };
  return jwks;
}

/**
 * Verify a Google-issued OIDC id_token. Throws on any failure (signature, kid
 * not in JWKS, iss/aud mismatch, expired). Returns the validated claims.
 *
 * @param idToken     The id_token string from /token response.
 * @param expectedAud Our GOOGLE_CLIENT_ID — Google ALWAYS sets aud to the
 *                    requesting client_id, so this MUST match or the token
 *                    was minted for someone else.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedAud: string,
): Promise<JwtClaims> {
  const header = decodeJwtHeader(idToken);
  if (!header.kid) {
    throw new Error('Google id_token missing kid header');
  }
  const jwks = await fetchGoogleJwks();
  const matchingKey = jwks.keys.find((k) => k.kid === header.kid);
  let claims: JwtClaims;
  if (!matchingKey) {
    // Possible if Google just rotated keys; force-refresh once and retry.
    jwksCache = null;
    const refreshed = await fetchGoogleJwks();
    const retry = refreshed.keys.find((k) => k.kid === header.kid);
    if (!retry) throw new Error(`Google id_token kid "${header.kid}" not in JWKS`);
    claims = await verifyJwt(idToken, await importPublicJwk(retry), {
      expectedIss: ALLOWED_ISSUERS,
      expectedAud,
    });
  } else {
    const publicKey = await importPublicJwk(matchingKey);
    claims = await verifyJwt(idToken, publicKey, {
      expectedIss: ALLOWED_ISSUERS,
      expectedAud,
    });
  }

  // v2.33.58 round 12 C2/H4: Enforce email_verified === true here (defense in depth)。
  // 之前 callback/google.ts 雖讀 email_verified 但不 enforce — 攻擊者拿未 verified 的
  // Google 帳號（hostile domain workspace / federated mis-config）若 callback 未阻擋，
  // 可能 squat 既有 email。在 verifier 內擋。
  const emailVerified = claims.email_verified;
  if (emailVerified !== true) {
    throw new Error('Google id_token email_verified is not true');
  }
  // OIDC §3.1.3.7 step 8: if azp (authorized party) is present, MUST equal expectedAud。
  const azp = claims['azp'];
  if (typeof azp === 'string' && azp !== expectedAud) {
    throw new Error(`Google id_token azp mismatch: got "${azp}"`);
  }
  return claims;
}
