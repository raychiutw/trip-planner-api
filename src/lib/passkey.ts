/**
 * passkey（WebAuthn）註冊驗證，只用 WebCrypto，不引入第三方函式庫（ADR-0016）。
 *
 * 範圍刻意收斂：attestation 一律當 `none` 處理（不驗憑證鏈，只取公鑰）、只收 ES256（COSE alg -7，P-256）。
 * shortcut: 只支援 ES256，要支援 RS256（Windows Hello 舊裝置）時再擴充 COSE 解析與 pubKeyCredParams。
 */
import { AppError } from '../errors';
import type { Env } from '../env';

/** ADR-0016：RP ID 用現有 web 網域；可用 PASSKEY_RP_ID 覆寫（例如預覽環境）。 */
export const DEFAULT_PASSKEY_RP_ID = 'trip-planner-dby.pages.dev';
export const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;
export const PASSKEY_CHALLENGE_MODEL = 'PasskeyChallenge';

/** 來源清單：web 網域＋環境變數 PASSKEY_EXTRA_ORIGINS（逗號分隔，預設空；例如 Android 原生 App 的 `android:apk-key-hash:…`）。註冊與登入共用。 */
export function passkeyRp(env: Env): { id: string; origins: string[] } {
  const id = env.PASSKEY_RP_ID || DEFAULT_PASSKEY_RP_ID;
  const extra = (env.PASSKEY_EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return { id, origins: [`https://${id}`, ...extra] };
}

export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ───────── 最小 CBOR 解碼（只支援 attestationObject 與 COSE 公鑰會用到的型別）─────────

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function cborDecode(buf: Uint8Array, start = 0, depth = 0): [Cbor, number] {
  if (depth > 8 || start >= buf.length) throw new Error('cbor');
  const initial = buf[start]!;
  const major = initial >> 5;
  const info = initial & 31;
  let pos = start + 1;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24 || info === 25 || info === 26) {
    const n = info === 24 ? 1 : info === 25 ? 2 : 4;
    if (pos + n > buf.length) throw new Error('cbor');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + i]!;
    pos += n;
  } else throw new Error('cbor'); // 不支援 64 位元長度與 indefinite length
  switch (major) {
    case 0: return [len, pos];
    case 1: return [-1 - len, pos];
    case 2:
    case 3: {
      if (pos + len > buf.length) throw new Error('cbor');
      const bytes = buf.slice(pos, pos + len);
      return [major === 2 ? bytes : new TextDecoder().decode(bytes), pos + len];
    }
    case 4: {
      const arr: Cbor[] = [];
      for (let i = 0; i < len; i++) { const [v, next] = cborDecode(buf, pos, depth + 1); arr.push(v); pos = next; }
      return [arr, pos];
    }
    case 5: {
      if (len > 32) throw new Error('cbor');
      const map = new Map<number | string, Cbor>();
      for (let i = 0; i < len; i++) {
        const [k, afterKey] = cborDecode(buf, pos, depth + 1);
        if (typeof k !== 'number' && typeof k !== 'string') throw new Error('cbor');
        const [v, next] = cborDecode(buf, afterKey, depth + 1);
        map.set(k, v);
        pos = next;
      }
      return [map, pos];
    }
    default: throw new Error('cbor');
  }
}

// ───────── 驗證 ─────────

export type PasskeyFailure = 'malformed' | 'origin_mismatch' | 'rp_id_mismatch' | 'uv_required' | 'unsupported_alg' | 'credential_id_mismatch';

export class PasskeyError extends AppError {
  constructor(readonly reason: PasskeyFailure, detail?: string) {
    super(reason === 'origin_mismatch' ? 'PASSKEY_ORIGIN_MISMATCH' : reason === 'uv_required' ? 'PASSKEY_UV_REQUIRED' : 'PASSKEY_REGISTRATION_INVALID', detail);
  }
}

const bad = (reason: PasskeyFailure, detail: string): never => { throw new PasskeyError(reason, detail); };

export interface ClientData { type: string; challenge: string; origin: string }

export function parseClientData(b64: string): ClientData {
  try { return parseClientDataBytes(b64uDecode(b64)); } catch { return bad('malformed', 'clientDataJSON 無法解析'); }
}

/** 解析失敗丟 PasskeyAssertionError('malformed')；註冊那邊由 parseClientData 轉成 PasskeyError。 */
function parseClientDataBytes(bytes: Uint8Array): ClientData {
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof j.type === 'string' && typeof j.challenge === 'string' && typeof j.origin === 'string') {
      return { type: j.type, challenge: j.challenge, origin: j.origin };
    }
  } catch { /* fall through */ }
  return failAssert('malformed');
}

export interface VerifiedRegistration {
  credentialId: string;
  /** COSE 公鑰原始位元組（base64url）。 */
  publicKey: string;
  alg: number;
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
  aaguid: string;
}

/** 驗證 clientData 的 type／origin，以及 attestationObject 的 RP ID、UP／UV 旗標與公鑰。challenge 由呼叫端先驗。 */
export async function verifyRegistration(
  input: { credentialId: string; clientData: ClientData; attestationObject: string },
  rp: { id: string; origins: string[] },
): Promise<VerifiedRegistration> {
  if (input.clientData.type !== 'webauthn.create') bad('malformed', 'clientData.type 不是 webauthn.create');
  if (!rp.origins.includes(input.clientData.origin)) bad('origin_mismatch', '來源網域不符');

  let att: Cbor;
  try { att = cborDecode(b64uDecode(input.attestationObject))[0]; } catch { return bad('malformed', 'attestationObject 無法解析'); }
  const authData = att instanceof Map ? att.get('authData') : undefined;
  if (!(authData instanceof Uint8Array) || authData.length < 55) return bad('malformed', '缺少 authenticatorData');

  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rp.id)));
  if (!rpHash.every((b, i) => b === authData[i])) bad('rp_id_mismatch', 'RP ID 不符');
  const flags = authData[32]!;
  if (!(flags & 0x01)) bad('malformed', '沒有使用者在場（UP）');
  if (!(flags & 0x04)) bad('uv_required', '必須完成使用者驗證（生物辨識或裝置密碼）');
  if (!(flags & 0x40)) bad('malformed', '沒有憑證資料（AT）');

  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  const aaguid = b64uEncode(authData.slice(37, 53));
  const idLen = (authData[53]! << 8) | authData[54]!;
  if (authData.length < 55 + idLen) return bad('malformed', 'authenticatorData 長度不符');
  const credId = authData.slice(55, 55 + idLen);
  if (b64uEncode(credId) !== input.credentialId) bad('credential_id_mismatch', '憑證 ID 不一致');

  let cose: Cbor;
  let end: number;
  try { [cose, end] = cborDecode(authData, 55 + idLen); } catch { return bad('malformed', 'COSE 公鑰無法解析'); }
  if (!(cose instanceof Map)) return bad('malformed', 'COSE 公鑰格式不符');
  const alg = cose.get(3);
  if (alg !== -7 || cose.get(1) !== 2 || cose.get(-1) !== 1) return bad('unsupported_alg', '只支援 ES256（P-256）');
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return bad('malformed', '公鑰座標長度不符');
  try { // 確認真的是曲線上的點，登入時才用得了
    await crypto.subtle.importKey('raw', new Uint8Array([4, ...x, ...y]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { return bad('malformed', '公鑰無效'); }

  return {
    credentialId: input.credentialId,
    publicKey: b64uEncode(authData.slice(55 + idLen, end)),
    alg: -7,
    signCount,
    backupEligible: !!(flags & 0x08),
    backedUp: !!(flags & 0x10),
    aaguid,
  };
}

// ───────── 登入（assertion）驗證 ─────────

export type AssertionFailure = 'malformed' | 'origin_mismatch' | 'rp_id_mismatch' | 'uv_required' | 'bad_signature';

export class PasskeyAssertionError extends Error {
  constructor(readonly reason: AssertionFailure) { super(reason); }
}

const failAssert = (reason: AssertionFailure): never => { throw new PasskeyAssertionError(reason); };

/** DER（SEQUENCE of two INTEGER）轉 WebCrypto 要的 r||s（各 32 位元組）。 */
function derToRaw(der: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  if (der[0] !== 0x30 || der.length < 8) return failAssert('bad_signature');
  let pos = 2;
  if (der[1]! & 0x80) { if (der[1] !== 0x81) return failAssert('bad_signature'); pos = 3; }
  for (let part = 0; part < 2; part++) {
    if (der[pos] !== 0x02) return failAssert('bad_signature');
    let len = der[pos + 1]!;
    let start = pos + 2;
    if (start + len > der.length) return failAssert('bad_signature');
    while (len > 32 && der[start] === 0) { start++; len--; }
    if (len > 32) return failAssert('bad_signature');
    out.set(der.slice(start, start + len), part * 32 + 32 - len);
    pos = start + len;
  }
  return out;
}

export interface VerifiedAssertion { signCount: number }

/**
 * 驗證 assertion：clientData 的 type／origin、authenticatorData 的 RP ID 雜湊與 UP／UV 旗標、簽名。
 * challenge、憑證屬主與簽名計數由呼叫端處理。publicKey 是註冊時存下的 COSE 公鑰（base64url）。
 */
export async function verifyAssertion(
  input: { clientDataJSON: string; authenticatorData: string; signature: string; publicKey: string },
  rp: { id: string; origins: string[] },
): Promise<VerifiedAssertion> {
  let clientBytes: Uint8Array; let authData: Uint8Array; let sig: Uint8Array;
  try {
    clientBytes = b64uDecode(input.clientDataJSON); authData = b64uDecode(input.authenticatorData); sig = derToRaw(b64uDecode(input.signature));
  } catch (e) { return e instanceof PasskeyAssertionError ? failAssert(e.reason) : failAssert('malformed'); }
  const clientData = parseClientDataBytes(clientBytes);
  if (clientData.type !== 'webauthn.get') failAssert('malformed');
  if (!rp.origins.includes(clientData.origin)) failAssert('origin_mismatch');
  if (authData.length < 37) return failAssert('malformed');

  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rp.id)));
  if (!rpHash.every((b, i) => b === authData[i])) failAssert('rp_id_mismatch');
  const flags = authData[32]!;
  if (!(flags & 0x01)) failAssert('malformed'); // 沒有使用者在場（UP）
  if (!(flags & 0x04)) failAssert('uv_required');

  let key: CryptoKey;
  try {
    const cose = cborDecode(b64uDecode(input.publicKey))[0];
    const x = cose instanceof Map ? cose.get(-2) : undefined;
    const y = cose instanceof Map ? cose.get(-3) : undefined;
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error('cose');
    key = await crypto.subtle.importKey('raw', new Uint8Array([4, ...x, ...y]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { return failAssert('bad_signature'); }

  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientBytes));
  const signed = new Uint8Array([...authData, ...clientHash]);
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed))) failAssert('bad_signature');
  return { signCount: new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0) };
}
