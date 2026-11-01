/**
 * _tripWrite — low-level primitives for creating a new trip via chunked,
 * rollback-safe D1 writes. Both creation endpoints call the shared module.
 *
 * New-trip creation consumes generated ids in JavaScript, so the module runs CHUNKED
 * sequential batches with INSERT…RETURNING id, track created ids, and connect-root
 * rollback on any failure. POIs are find-or-create by UNIQUE(name,type) with
 * fill-null policy: existing non-null fields stay intact; only newly-created
 * ids are tracked for rollback. The full creation flow lives in _createTrip.ts.
 */
import { AppError } from '../errors';
import { genTripId } from './tripId';

export const BATCH_CHUNK = 50; // application chunk size for new-trip creation; not D1's batch statement limit
export const MAX_TRIPS_PER_USER = 1000;

type Stmt = D1PreparedStatement;

/** Extract the RETURNING id; a missing id means the INSERT silently failed. */
export function reqId(r: D1Result, msg = '寫入失敗'): number {
  const id = (r.results?.[0] as { id?: number } | undefined)?.id;
  if (typeof id !== 'number' || id <= 0) throw new AppError('SYS_DB_ERROR', msg);
  return id;
}

/** Run statements in chunked atomic batches; onResult fires per result as each chunk
 *  commits, so a later chunk's failure still leaves earlier ids tracked. */
export async function runChunked(db: D1Database, stmts: Stmt[], onResult?: (r: D1Result, idx: number) => void): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    const res = await db.batch(stmts.slice(i, i + BATCH_CHUNK));
    if (onResult) res.forEach((r, j) => onResult(r, i + j));
  }
}

/** Best-effort connect-root cleanup of a partially-written trip (chunked). */
export async function rollbackTrip(db: D1Database, tripId: string, entryIds: number[], poiIds: number[]): Promise<void> {
  const stmts: Stmt[] = [];
  for (let i = 0; i < entryIds.length; i += 100) {
    const chunk = entryIds.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    stmts.push(db.prepare(`DELETE FROM trip_entry_pois WHERE entry_id IN (${ph})`).bind(...chunk));
    stmts.push(db.prepare(`DELETE FROM trip_entries WHERE id IN (${ph})`).bind(...chunk));
  }
  stmts.push(db.prepare('DELETE FROM trip_segments WHERE trip_id = ?').bind(tripId));
  stmts.push(db.prepare('DELETE FROM trip_days WHERE trip_id = ?').bind(tripId));
  for (const t of ['trip_flights', 'trip_lodgings', 'trip_reservations', 'trip_pretrip_notes', 'trip_emergency_contacts', 'trip_destinations', 'trip_permissions']) {
    stmts.push(db.prepare(`DELETE FROM ${t} WHERE trip_id = ?`).bind(tripId));
  }
  for (let i = 0; i < poiIds.length; i += 100) {
    const chunk = poiIds.slice(i, i + 100);
    stmts.push(db.prepare(`DELETE FROM pois WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
  }
  stmts.push(db.prepare('DELETE FROM audit_log WHERE trip_id = ?').bind(tripId));
  stmts.push(db.prepare('DELETE FROM trips WHERE id = ?').bind(tripId));
  await runChunked(db, stmts);
}

/** Enforce the per-user trip cap (anti spam DoS). Throws if at/over the limit. */
export async function assertTripCap(db: D1Database, userId: string): Promise<void> {
  const row = await db.prepare('SELECT COUNT(*) AS cnt FROM trips WHERE owner_user_id = ?').bind(userId).first<{ cnt: number }>();
  if ((row?.cnt ?? 0) >= MAX_TRIPS_PER_USER) {
    throw new AppError('DATA_VALIDATION', `行程數已達上限（${MAX_TRIPS_PER_USER}）`);
  }
}

/**
 * 產生一個尚未被使用的行程 ID。
 *
 * 2026-07-21 之前 ID 由呼叫端提供，所以撞號回 `DATA_CONFLICT`（「tripId 已存在」）
 * 是合理的 —— 是呼叫端挑了被佔用的 id。ID 改由後端產生後，這個錯誤變成在怪罪
 * 一個根本無從選擇 id 的呼叫端，而且使用者沒有任何辦法自救。
 *
 * 碰撞機率極低（8 碼 base36），但機率低不等於處理方式可以是錯的：重生一個即可。
 * 重試三次仍撞代表不是運氣問題（DB 異常之類），此時才誠實往外拋。
 */
export async function generateUniqueTripId(
  db: D1Database,
  name: string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = genTripId(name);
    const taken = await db.prepare('SELECT 1 FROM trips WHERE id = ?').bind(candidate).first();
    if (!taken) return candidate;
  }
  throw new AppError('SYS_INTERNAL', '無法產生可用的行程 ID，請稍後再試');
}
