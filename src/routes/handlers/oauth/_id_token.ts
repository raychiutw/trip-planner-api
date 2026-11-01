/**
 * id_token issuance — V2-P5 OIDC compliance
 *
 * Issued by /api/oauth/token when scope includes 'openid'。Claims per OIDC §2 +
 * scope-conditional (email / profile)。
 *
 * Sign 用 env OAUTH_SIGNING_PRIVATE_KEY (PKCS8)。缺 key 時回 null（略過簽發，不是失敗）：
 * caller 就不把 id_token 放進回應。
 */
import { signJwt, importPrivateKey, computeKid } from '../../../lib/jwt';
import { getOidcIssuer } from '../../../lib/utils';
import { AppError } from '../../../errors';
import type { Env } from '../../../env';

const ID_TOKEN_TTL_SEC = 60 * 60; // 1h

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  email_verified_at: string | null;
}

/**
 * Issue id_token JWT for given user + client + scopes。
 * Returns null if scopes 不含 'openid'，或環境沒有簽章 key（caller 不應 include id_token in response）。
 */
export async function issueIdToken(
  env: Env,
  request: Request,
  clientId: string,
  userId: string,
  scopes: string[],
): Promise<string | null> {
  if (!scopes.includes('openid')) return null;

  if (!env.OAUTH_SIGNING_PRIVATE_KEY) {
    return null; // 未設定簽章 key：略過簽發（token endpoint 不該因此失敗）
  }

  // Look up user fields needed for claims
  const user = await env.DB
    .prepare('SELECT id, email, display_name, email_verified_at FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();
  if (!user) {
    throw new AppError('SYS_INTERNAL', `User ${userId} not found — cannot issue id_token`);
  }

  // v2.33.59 round 13: 用 PUBLIC_ORIGIN env 取代 Host header (id_token iss
  // 是 OIDC trust anchor — 必須穩定且不可 attacker-spoofable)
  //
  // v2.55.85: 改用 getOidcIssuer —— 先前直接用 getPublicOrigin 少了 /api/oauth
  // 後綴，與 discovery doc 宣告的 issuer 不一致（見該函式註解）。
  const issuer = getOidcIssuer(env, request);
  const now = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    iss: issuer,
    sub: userId,
    aud: clientId,
    iat: now,
    exp: now + ID_TOKEN_TTL_SEC,
  };

  // Conditional claims per scope
  if (scopes.includes('email') || scopes.includes('profile')) {
    claims.email = user.email;
    claims.email_verified = user.email_verified_at != null;
  }
  if (scopes.includes('profile')) {
    claims.name = user.display_name ?? user.email.split('@')[0];
  }

  const privateKey = await importPrivateKey(env.OAUTH_SIGNING_PRIVATE_KEY);
  const kid = await computeKid(privateKey);
  return signJwt(claims as never, privateKey, kid);
}
