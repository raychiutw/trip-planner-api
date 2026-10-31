/** 由舊入口 functions/api/_utils.ts 逐字摘出的兩個純密碼學 helper（其餘 _utils 內容依賴 HTTP/AppError，未搬）。 */

export function generateOpaqueToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SHA-256(input) base64 — used by auth-audit, session etc. for IP hashing.
 * Centralised so a single hash-algorithm change applies everywhere.
 */
export async function sha256Base64(input: string): Promise<string> {
  // v2.33.101 CR-6: crypto.subtle.digest 接受 BufferSource (= ArrayBuffer |
  // ArrayBufferView)。Uint8Array 是 ArrayBufferView，可直接傳；之前 `as unknown
  // as ArrayBuffer` 是 unsound double-cast (lying about type to silence TS)。
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const arr = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]!);
  return btoa(str);
}

/** SHA-256 的 base64url（無 padding）；用於把 ticket／token 雜湊後再存庫。 */
export async function sha256Base64Url(input: string): Promise<string> {
  return (await sha256Base64(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
