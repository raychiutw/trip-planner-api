/**
 * cryptoBuffer.ts — Web Crypto API buffer cast helper
 *
 * TypeScript DOM lib 對 `BufferSource` 嚴格要求 `ArrayBuffer`（不接 `Uint8Array.buffer`
 * 的 SharedArrayBuffer / `ArrayBufferLike` union），但 runtime 上 Uint8Array 是
 * BufferSource 的合法子集。集中 cast helper 讓單檔 `as unknown as` 數量符合 CR-7
 * 上限（3 處/檔），同時把不可避免的型別 hack 收歸一處。
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes as unknown as ArrayBuffer;
}
