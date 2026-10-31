/**
 * _validate.ts — server-side 必填驗證邏輯
 * 抽成獨立函式以便 unit test 直接覆蓋，不需啟動完整 server。
 */

export interface DayBody {
  date?: string;
  dayOfWeek?: string;
  label?: string;
  [key: string]: unknown;
}

export interface ValidationResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * 驗證 PUT /days/:num 的 request body。
 * 回傳 { ok: true } 表示驗證通過；否則回傳 { ok: false, status, error }。
 */
export function validateDayBody(body: DayBody): ValidationResult {
  for (const field of ['weather', 'weather_json'] as const) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return { ok: false, status: 400, error: `${field} 已移除` };
    }
  }

  // Required field validation
  const missing: string[] = [];
  if (!body.date) missing.push('date');
  if (!body.dayOfWeek) missing.push('dayOfWeek');
  if (!body.label) missing.push('label');
  if (missing.length > 0) {
    return { ok: false, status: 400, error: `必填欄位缺失: ${missing.join(', ')}` };
  }

  // date format validation (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date!)) {
    return { ok: false, status: 400, error: 'date 格式必須為 YYYY-MM-DD' };
  }

  // label length validation (≤ 8 characters)
  if (body.label!.length > 8) {
    return { ok: false, status: 400, error: 'label 不得超過 8 字' };
  }

  return { ok: true, status: 200 };
}

export interface EntryBody {
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
  source?: string | null;
  [key: string]: unknown;
}

/**
 * Allowlist for entry/POI source values written to pois.source / trip_entries.source.
 * v2.31.94: closes storage-abuse vector — unbounded user-supplied source string
 * could inflate D1 rows. Allowlist matches the values actually written by
 * frontend callers (see usage grep). Add new values here when adding new
 * acquisition channels.
 */
const ALLOWED_SOURCES = new Set([
  'ai',           // default + AI-generated
  'google',       // Google Places search result
  'favorite',     // poi_favorites → trip
  'custom',       // v2.31.94 map pin (this PR)
  'search',       // legacy frontend selected-state value (read-only path)
  'user-explore', // /explore page save flow
  'manual',       // future-proofing (aligns with trips.data_source)
]);

function coordPresent(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function isValidCoord(value: unknown, kind: 'lat' | 'lng'): boolean {
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) return false;
  const limit = kind === 'lat' ? 90 : 180;
  return value >= -limit && value <= limit;
}

/**
 * 驗證 PATCH /entries/:eid 的 request body。
 * 回傳 { ok: true } 表示驗證通過；否則回傳 { ok: false, status, error }。
 *
 * v2.31.94: 加 lat/lng range check（custom stop with map pin 路徑）。
 * - 任一存在 → 兩個都必填（XOR 拒絕）
 * - 必為 finite number（非 NaN / Infinity / string）
 * - lat ∈ [-90, 90], lng ∈ [-180, 180]
 * - 既有純 name 路徑（無 lat/lng）不受影響
 */
export function validateEntryBody(body: EntryBody): ValidationResult {
  if (!body.name) {
    return { ok: false, status: 400, error: '必填欄位缺失: name' };
  }

  const hasLat = coordPresent(body.lat);
  const hasLng = coordPresent(body.lng);
  if (hasLat !== hasLng) {
    return { ok: false, status: 400, error: '無效座標：lat/lng 必須同時提供' };
  }
  if (hasLat && hasLng) {
    if (!isValidCoord(body.lat, 'lat') || !isValidCoord(body.lng, 'lng')) {
      return { ok: false, status: 400, error: '無效座標：lat ∈ [-90,90] / lng ∈ [-180,180]' };
    }
  }

  // v2.31.94: source allowlist — blocks unbounded string storage abuse.
  // body.source absent / null is OK (entries.ts:87 forward falls back to 'ai').
  if (body.source !== undefined && body.source !== null) {
    if (typeof body.source !== 'string' || !ALLOWED_SOURCES.has(body.source)) {
      return { ok: false, status: 400, error: `source 無效（允許：${[...ALLOWED_SOURCES].join(', ')}）` };
    }
  }

  return { ok: true, status: 200 };
}

/**
 * 啟發式偵測疑似亂碼字串（常見於 CP950/Big5 → UTF-8 誤轉）。
 * 回傳 true 表示偵測到亂碼特徵。
 */
export function detectGarbledText(text: string): boolean {
  if (!text || typeof text !== 'string') return false;

  // 規則一：U+FFFD（Unicode Replacement Character）
  // 瀏覽器/平台在無法解析某 byte 時插入此字元，出現即代表原始 bytes 非合法 UTF-8。
  if (text.includes('\uFFFD')) return true;

  // 規則二：連續 3+ 個 Latin Extended（U+0080–U+00FF）
  // CP950/Big5 多位元組字元誤當 ISO-8859-1 解碼後，常產生一串 Latin Extended 字元；
  // 合法中文 UTF-8 不會產生此特徵，故 3 個以上視為亂碼。
  if (/[\u0080-\u00FF]{3,}/.test(text)) return true;

  // 規則三：C1 控制字元（U+0080–U+009F）
  // 這段範圍在 UTF-8 正常文字內容中不應出現；
  // 若有則表示原始資料含有 Windows-1252 或其他單位元組編碼的殘留。
  if (/[\x80-\x9F]/.test(text)) return true;

  return false;
}

const SENSITIVE_REPLY_PATTERNS = [
  /\/api\/\w/i,
  /trip_(days|entries|pois|permissions|requests|docs)|audit_log|poi_relations/,
  /\bSELECT\s+\w+\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /CF-Access|Service.Token|middleware/i,
  /functions\/api/,
  /\.bind\(|\.prepare\(/,
  /onRequest(Get|Post|Put|Patch|Delete)/,
];

const SANITIZED_FALLBACK = '已處理您的請求。如有問題請直接聯繫行程主人。';

// tp-request containment：bound reply length so a prompt-injected companion agent
// can't use the reply as a bulk exfil channel for the (single) trip's data.
const MAX_REPLY_LEN = 2000;

export function sanitizeReply(reply: string): string {
  for (const pattern of SENSITIVE_REPLY_PATTERNS) {
    if (pattern.test(reply)) return SANITIZED_FALLBACK;
  }
  return reply.length > MAX_REPLY_LEN ? reply.slice(0, MAX_REPLY_LEN) + '…' : reply;
}
