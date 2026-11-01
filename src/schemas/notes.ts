/**
 * 行程筆記（notes 組）的 OpenAPI／契約 schema。
 *
 * 命名慣例（與舊 handler 的實際行為一致，並非設計上的美感）：
 * - 請求 body 的欄位是 snake_case（對齊 DB 欄位白名單 ALLOWED_FIELDS），
 *   但 `expectedVersion`／`managedBy`／reorder 的 `sortOrder` 是 camelCase。
 * - 回應一律經 deepCamel，所以是 camelCase（tripId、sortOrder、createdAt…）。
 * 五種筆記類型的列結構各不相同，各自一個 schema。
 */
import { z } from '@hono/zod-openapi';
import { ApiError } from './common';

const Id = z.number().int();

/** 每張筆記表共有的欄位（SELECT * 的結果，經 camelCase 轉換）。 */
const rowBase = {
  id: Id,
  tripId: z.string(),
  sortOrder: z.number().int(),
  version: z.number().int().openapi({ description: '樂觀鎖版本；每次 PATCH／reorder 加 1。' }),
  createdAt: z.string(),
  updatedAt: z.string(),
};

/** AI 維護欄位（只有 pretrip／emergency 兩張表有，migration 0091）。 */
const aiColumns = {
  aiGenerated: z.number().int().openapi({ description: '舊欄位，0 或 1。' }),
  origin: z.enum(['human', 'ai']),
  managedBy: z.enum(['human', 'ai']),
  semanticKey: z.string().nullable(),
};

export const Notes_Flight = z.object({
  ...rowBase,
  airline: z.string(),
  flightNo: z.string(),
  cabinClass: z.string(),
  departAirport: z.string(),
  arriveAirport: z.string(),
  departAt: z.string(),
  arriveAt: z.string(),
  note: z.string(),
}).openapi('Notes_Flight');

/** trip_lodgings 的文字欄位在 migration 0074 重建表時沒有 NOT NULL，未帶的欄位回 null。 */
export const Notes_Lodging = z.object({
  ...rowBase,
  name: z.string().nullable(),
  address: z.string().nullable(),
  checkInAt: z.string().nullable(),
  checkOutAt: z.string().nullable(),
  bookingNo: z.string().nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
}).openapi('Notes_Lodging');

export const Notes_Reservation = z.object({
  ...rowBase,
  kind: z.enum(['restaurant', 'experience', 'ticket', 'transport', 'other']),
  title: z.string(),
  reservedAt: z.string(),
  partySize: z.number().int(),
  reservationNo: z.string(),
  phone: z.string(),
  note: z.string(),
}).openapi('Notes_Reservation');

export const Notes_PretripNote = z.object({
  ...rowBase,
  section: z.string(),
  title: z.string(),
  content: z.string().openapi({ description: 'markdown 文字，非 JSON。' }),
  aiSource: z.string().nullable().openapi({ description: "null＝人工；'lodging-tips'／'general-tips'＝AI 來源。" }),
  ...aiColumns,
}).openapi('Notes_PretripNote');

export const Notes_EmergencyContact = z.object({
  ...rowBase,
  name: z.string(),
  relationship: z.string(),
  phone: z.string(),
  email: z.string(),
  kind: z.enum(['personal', 'embassy', 'police', 'medical', 'insurance', 'hotel', 'other']),
  ...aiColumns,
}).openapi('Notes_EmergencyContact');

// ───── 請求 body（全部欄位選填；白名單以外的欄位被 handler 靜默忽略；trip_id／version 不可由 body 指定）─────
const sortOrder = z.number().int().optional().openapi({ description: '省略時 POST 會自動排到最後（MAX+1）。' });

export const Notes_FlightInput = z.object({
  sort_order: sortOrder,
  airline: z.string().optional(), flight_no: z.string().optional(), cabin_class: z.string().optional(),
  depart_airport: z.string().optional(), arrive_airport: z.string().optional(),
  depart_at: z.string().optional(), arrive_at: z.string().optional(), note: z.string().optional(),
}).openapi('Notes_FlightInput');

export const Notes_LodgingInput = z.object({
  sort_order: sortOrder,
  name: z.string().optional(), address: z.string().optional(),
  check_in_at: z.string().optional(), check_out_at: z.string().optional(),
  booking_no: z.string().optional(), phone: z.string().optional(), note: z.string().optional(),
}).openapi('Notes_LodgingInput');

export const Notes_ReservationInput = z.object({
  sort_order: sortOrder,
  kind: z.enum(['restaurant', 'experience', 'ticket', 'transport', 'other']).optional(),
  title: z.string().optional(), reserved_at: z.string().optional(), party_size: z.number().int().optional(),
  reservation_no: z.string().optional(), phone: z.string().optional(), note: z.string().optional(),
}).openapi('Notes_ReservationInput');

export const Notes_PretripNoteInput = z.object({
  sort_order: sortOrder,
  section: z.string().optional(), title: z.string().optional(), content: z.string().optional(),
}).openapi('Notes_PretripNoteInput');

export const Notes_EmergencyContactInput = z.object({
  sort_order: sortOrder,
  name: z.string().optional(), relationship: z.string().optional(), phone: z.string().optional(),
  email: z.string().optional(),
  kind: z.enum(['personal', 'embassy', 'police', 'medical', 'insurance', 'hotel', 'other']).optional(),
}).openapi('Notes_EmergencyContactInput');

/** PATCH：同 Input，另可帶 expectedVersion（樂觀鎖，不符回 409 STALE_ENTRY）；至少要有一個有效欄位，否則 400。 */
const patchOf = <T extends z.ZodObject<z.ZodRawShape>>(input: T, name: string) =>
  input.extend({ expectedVersion: z.number().int().optional().openapi({ description: '樂觀鎖；不符回 409 STALE_ENTRY。' }) }).openapi(name);

export const Notes_FlightPatch = patchOf(Notes_FlightInput, 'Notes_FlightPatch');
export const Notes_LodgingPatch = patchOf(Notes_LodgingInput, 'Notes_LodgingPatch');
export const Notes_ReservationPatch = patchOf(Notes_ReservationInput, 'Notes_ReservationPatch');
export const Notes_PretripNotePatch = patchOf(Notes_PretripNoteInput, 'Notes_PretripNotePatch');
export const Notes_EmergencyContactPatch = patchOf(Notes_EmergencyContactInput, 'Notes_EmergencyContactPatch');

/**
 * reorder：items 非空；id 為正整數且不可重複；sortOrder 為非負整數（後兩者 handler 驗證）。
 * 重複 id 無法用純結構表達，以 refine 寫進文件 schema（文件不在執行期驗證）。
 */
export const Notes_ReorderInput = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    sortOrder: z.number().int().min(0),
  })).min(1).refine((items) => new Set(items.map((i) => i.id)).size === items.length, { message: 'items 不可包含重複 id' })
    .openapi({ description: 'id 必須屬於該行程與該區段，否則 403；不可有重複 id。' }),
}).openapi('Notes_ReorderInput');

// ───── 回應 ─────
export const Notes_Aggregate = z.object({
  flights: z.array(Notes_Flight),
  lodgings: z.array(Notes_Lodging),
  reservations: z.array(Notes_Reservation),
  pretripNotes: z.array(Notes_PretripNote),
  emergencyContacts: z.array(Notes_EmergencyContact),
}).openapi('Notes_Aggregate');

export const listOf = <T extends z.ZodTypeAny>(row: T) => z.object({ items: z.array(row) });

export const Notes_DeleteResult = z.object({
  ok: z.boolean(),
  excluded: z.boolean().openapi({ description: '刪除的是 AI 產生且仍由 AI 維護的列時為 true（同時寫入排除項，避免重新生成又長回來）。' }),
}).openapi('Notes_DeleteResult');

export const Notes_ReorderResult = z.object({ ok: z.boolean(), updated: z.number().int() }).openapi('Notes_ReorderResult');
export const Notes_Ok = z.object({ ok: z.boolean() }).openapi('Notes_Ok');

export const Notes_AiJobState = z.object({
  docType: z.enum(['lodging-tips', 'tips', 'emergency']),
  status: z.enum(['idle', 'pending', 'processing', 'completed', 'failed', 'timedOut']).openapi({ description: "從未生成過為 'idle'；DB 的 timed_out 轉成 'timedOut'。" }),
  jobId: z.number().int().nullable(),
  requestId: z.number().int().nullable(),
  generation: z.number().int(),
  insertedCount: z.number().int(),
  replacedCount: z.number().int(),
  preservedManualCount: z.number().int(),
  duplicateExcludedCount: z.number().int(),
  suppressedCount: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  timeoutAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  exclusionCount: z.number().int(),
}).openapi('Notes_AiJobState');

export const Notes_AiState = z.object({ jobs: z.array(Notes_AiJobState) }).openapi('Notes_AiState');

export const Notes_Exclusion = z.object({
  id: Id,
  docType: z.enum(['lodging-tips', 'tips', 'emergency']),
  semanticKey: z.string(),
  label: z.string(),
  deletedAt: z.string(),
}).openapi('Notes_Exclusion');

export const Notes_GenerateJob = z.object({
  jobId: z.number().int(),
  requestId: z.number().int(),
  status: z.string().openapi({ description: "新建為 'pending'；已有進行中的 job 時回其目前狀態（pending／processing）。" }),
  generation: z.number().int(),
  timeoutAt: z.string(),
  tripId: z.string(),
  docType: z.enum(['lodging-tips', 'tips', 'emergency']),
}).openapi('Notes_GenerateJob');

export const Notes_MaintenanceInput = z.object({
  managedBy: z.enum(['ai', 'human']),
  expectedVersion: z.number().int().min(0),
}).openapi('Notes_MaintenanceInput');

/** maintenance 只支援 pretrip／emergency，回傳該列（依 :section 為其中一種形狀）。 */
export const Notes_MaintenanceRow = z.union([Notes_PretripNote, Notes_EmergencyContact]);

// ───── 回應表輔助 ─────
const ERR: Record<number, string> = {
  400: '驗證失敗（DATA_VALIDATION：JSON 無效、欄位型別／enum 不符、id 非正整數…）',
  401: '未帶或無效的 bearer（AUTH_REQUIRED／AUTH_INVALID）',
  403: '沒有該行程的權限（PERM_DENIED）；列或 id 不屬於該行程時也是 403',
  404: '找不到（DATA_NOT_FOUND）',
  409: '版本衝突（STALE_ENTRY）或狀態不允許（NOTES_AI_NOT_REASSIGNABLE）',
};

/** 組出 { 成功碼, 錯誤碼... } 的 responses；錯誤碼一律 ApiError。 */
export function responsesOf(ok: Record<number, { description: string; schema?: z.ZodTypeAny }>, ...errors: number[]) {
  return { ...ok, ...Object.fromEntries(errors.map((c) => [c, { description: ERR[c]!, schema: ApiError }])) };
}
