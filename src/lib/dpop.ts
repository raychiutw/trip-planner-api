/**
 * DPoP（RFC 9449）proof 驗證。
 *
 * proof 是 client 以自己的私鑰簽的短效 JWT：header 帶公鑰 jwk，claims 帶 htm（HTTP 方法）、htu（URL）、
 * iat、jti，打資源端點時另帶 ath（access token 的 SHA-256）。token 綁定公鑰指紋（jkt），
 * 沒有私鑰就無法產生有效 proof，所以 token 外洩也用不了。
 *
 * 只接受 ES256／EC P-256；拒絕 none、對稱演算法、含私鑰成員的 jwk、重複使用的 jti。
 */
import type { Env } from '../env';

const MAX_PROOF_LENGTH = 4096;
const MAX_JTI_LENGTH = 256;
/** iat 容許的誤差（秒，前後各一次）；jti 紀錄保留兩倍以涵蓋整個有效窗口。 */
export const DPOP_WINDOW_SEC = 60;
const JTI_MODEL = 'DPoPJti';
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

export type DpopResult = { ok: true; jkt: string } | { ok: false; reason: string };

const fail = (reason: string): DpopResult => ({ ok: false, reason });

function b64uToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64u(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const parseJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

async function sha256B64u(input: string): Promise<string> {
  return bytesToB64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/** RFC 7638：EC 金鑰的必要成員依字典序、無空白。 */
export async function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): Promise<string> {
  return sha256B64u(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

/** htu 比對只看 scheme + host + path（忽略 query／fragment）。 */
function normalizeHtu(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

/** 取請求上唯一的 DPoP header；沒有回 null，多個回 'multiple'。 */
export function readDpopHeader(request: Request): string | null | 'multiple' {
  const v = request.headers.get('DPoP');
  if (v === null) return null;
  // 多個 header 會被 fetch 以逗號合併；JWT 本身不含逗號，所以有逗號就是多個
  return v.includes(',') ? 'multiple' : v;
}

/**
 * 驗證 proof。accessToken 有給 = 資源請求（必須帶正確的 ath）；沒給 = token endpoint。
 * 驗證全部通過後才登記 jti，無效 proof 不會寫入資料庫。
 */
export async function verifyDpopProof(
  request: Request,
  db: Env['DB'],
  opts: { accessToken?: string; now?: number } = {},
): Promise<DpopResult> {
  const raw = readDpopHeader(request);
  if (raw === null) return fail('missing');
  if (raw === 'multiple') return fail('multiple proofs');
  if (raw.length > MAX_PROOF_LENGTH) return fail('too long');

  try {
    const parts = raw.split('.');
    if (parts.length !== 3) return fail('not a JWT');
    const [h, p, s] = parts as [string, string, string];
    const header = parseJson(h) as Record<string, unknown>;
    const claims = parseJson(p) as Record<string, unknown>;
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return fail('malformed');

    if (header.typ !== 'dpop+jwt') return fail('typ');
    if (header.alg !== 'ES256') return fail('alg');
    const jwk = header.jwk as Record<string, unknown> | undefined;
    if (!jwk || typeof jwk !== 'object') return fail('jwk');
    if (PRIVATE_JWK_MEMBERS.some((m) => m in jwk)) return fail('jwk has private members');
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return fail('jwk');
    const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };

    const key = await crypto.subtle.importKey('jwk', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64uToBytes(s) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return fail('signature');

    if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > MAX_JTI_LENGTH) return fail('jti');
    if (claims.htm !== request.method) return fail('htm');
    const htu = typeof claims.htu === 'string' ? normalizeHtu(claims.htu) : null;
    if (!htu || htu !== normalizeHtu(request.url)) return fail('htu');
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || Math.abs(nowSec - claims.iat) > DPOP_WINDOW_SEC) return fail('iat');
    if (opts.accessToken !== undefined && claims.ath !== (await sha256B64u(opts.accessToken))) return fail('ath');

    const jkt = await jwkThumbprint(pub);
    // 最後才登記 jti（jti 以金鑰為範圍）；已存在 = 重放
    const res = await db
      .prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, '{}', ?) ON CONFLICT(name, id) DO NOTHING")
      .bind(JTI_MODEL, `${jkt}:${claims.jti}`, (opts.now ?? Date.now()) + 2 * DPOP_WINDOW_SEC * 1000)
      .run();
    if ((res.meta?.changes ?? 0) !== 1) return fail('replay');
    return { ok: true, jkt };
  } catch {
    return fail('malformed');
  }
}
