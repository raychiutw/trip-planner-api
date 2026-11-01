/** OAuth 相關端點共用的請求處理：限大小地讀 body、解析 JSON 物件、解析 client 的 allowed_scopes。 */

export const MAX_BODY_BYTES = 16 * 1024;

/**
 * 以位元組為單位、串流讀取 body；超過上限就中止，不會把巨大的 body 整個讀進記憶體。
 * 超過上限或讀取失敗回 null。
 */
export async function readBodyText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** 讀成 JSON 物件；太大、不是 JSON、不是物件（陣列、null、純值）都回 null。 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readBodyText(request);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** client_apps.allowed_scopes（JSON 字串）→ 字串陣列；壞掉一律視為空白名單（拒絕）。 */
export function parseAllowedScopes(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
