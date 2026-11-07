/** OAuth 簽章金鑰的測試材料（jwks 與 health 測試共用）：WebCrypto 產生，與 production 同一個 runtime。 */
/** 測試用金鑰材料：PKCS8 DER（WebCrypto 產生）與由它衍生的各種「貼錯」格式。 */
export async function keyMaterial() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
  const wrap = (label: string, bytes: Uint8Array) =>
    `-----BEGIN ${label}-----\n${b64(bytes).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
  // RSA 2048 的 PKCS8 前 26 bytes 是 INTEGER 0 + AlgorithmIdentifier + OCTET STRING 標頭，其後就是 PKCS1 RSAPrivateKey。
  const pkcs1 = pkcs8.slice(26);
  const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const ecPkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', ec.privateKey)) as ArrayBuffer);
  const pem = wrap('PRIVATE KEY', pkcs8);
  return {
    pem,
    base64: b64(pkcs8),
    literalBackslashN: pem.trim().replace(/\n/g, '\\n'),   // 換行被存成字面 \n（兩個字元）
    quoted: `"${pem.trim()}"`,
    crlf: pem.replace(/\n/g, '\r\n'),
    pkcs1Pem: wrap('RSA PRIVATE KEY', pkcs1),
    ecPem: wrap('PRIVATE KEY', ecPkcs8),
  };
}
