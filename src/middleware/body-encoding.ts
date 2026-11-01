/**
 * 非 JSON body 的 UTF-8／亂碼檢查（自舊 _middleware.ts 搬來）。
 *
 * JSON 請求不在這裡掃：handler 的 JSON.parse 失敗會丟 DATA_VALIDATION，user-facing 欄位各自做 detectGarbledText。
 * form-encoded／multipart／純文字沒有進 parseJsonBody，handler 不會自帶保護，所以在此統一檢查。
 * 只讀 request.clone()，不消耗原 body；錯誤訊息固定，不回顯 body 內容。
 */
import { AppError, errorResponse } from '../errors';
import { detectGarbledText } from '../lib/validate';

export async function bodyEncodingViolation(request: Request): Promise<Response | null> {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase())) return null;
  if ((request.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (detectGarbledText(text)) {
      return errorResponse(new AppError('DATA_ENCODING', 'Request body 包含疑似亂碼，請確認 encoding 為 UTF-8'));
    }
  } catch {
    return errorResponse(new AppError('DATA_ENCODING', 'Request body is not valid UTF-8'));
  }
  return null;
}
