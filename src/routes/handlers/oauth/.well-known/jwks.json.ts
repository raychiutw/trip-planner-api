/**
 * GET /api/oauth/.well-known/jwks.json — JWKS (JSON Web Key Set)
 *
 * V2-P5 — publish public key derived from env OAUTH_SIGNING_PRIVATE_KEY。
 * 若 env 未設則 keys=[]（dev 環境不能簽 id_token，但 endpoint 仍 200 不 crash）。
 *
 * V2-P6 加 key rotation：retire old key 但 keep in JWKS 一段時間（grace period）
 * 讓既有 token 仍能 verify。屆時改成讀 D1 oauth_models name='SigningKey' 取
 * status='active' OR status='retiring' 的 keys 一起發。
 */
import { importPrivateKey, exportPublicJwk, computeKid } from '../../../../lib/jwt';
import type { Env } from '../../../../env';

interface JwksKey {
  kty: string;
  use: string;
  kid: string;
  alg: string;
  n: string;
  e: string;
}

interface JsonWebKeySet {
  keys: JwksKey[];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const keys: JwksKey[] = [];

  if (context.env.OAUTH_SIGNING_PRIVATE_KEY) {
    try {
      const privateKey = await importPrivateKey(context.env.OAUTH_SIGNING_PRIVATE_KEY);
      const kid = await computeKid(privateKey);
      const jwk = await exportPublicJwk(privateKey, kid);
      keys.push(jwk);
    } catch {
      // env value malformed — fall through with empty keys array; ops will see
      // OIDC client failure and check env.
    }
  }

  const jwks: JsonWebKeySet = { keys };

  return new Response(JSON.stringify(jwks, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 1h CDN cache — V2-P6 key rotation 後 invalidate 才需要更短 TTL
      'cache-control': 'public, max-age=3600',
    },
  });
};
