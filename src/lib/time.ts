/**
 * Entry time helpers — v2.29.0: trip_entries.time DROPPED.
 *
 * 只剩 start_time / end_time。`resolveEntryTimes` 仍接受 legacy `body.time`
 * (e.g. older API client) 解析回填 start/end，但 schema 不再有 time col，所以
 * 寫入路徑只 INSERT/UPDATE start_time + end_time。
 */

/** HH:MM zero-padded 0-23 / 0-59 strict. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Parse legacy `time` string → { start, end }。給 backward-compat API 用。 */
export function parseTime(time?: string | null): { start: string | null; end: string | null } {
  if (!time || typeof time !== 'string') return { start: null, end: null };
  const trimmed = time.trim();
  if (!trimmed) return { start: null, end: null };
  const dash = trimmed.indexOf('-');
  if (dash > 0) {
    return { start: trimmed.slice(0, dash).trim(), end: trimmed.slice(dash + 1).trim() };
  }
  return { start: trimmed, end: null };
}

/**
 * 從 INSERT body / day timeline entry 解出 (startTime, endTime) pair。
 *
 * 規則：
 *   - body.start_time / body.end_time 顯式提供 → 優先
 *   - body.time legacy → 解析回填 start/end（backward-compat for old API clients）
 *   - 都沒提供 → 兩個 null
 *
 * 用於：PUT /days/:num bulk-insert、POST /days/:num/entries、copy.ts。
 * PATCH /entries 因為要 merge oldRow 用獨立邏輯（mergeTimesForPatch）。
 */
export function resolveEntryTimes(body: {
  start_time?: unknown;
  end_time?: unknown;
  time?: unknown;
}): { startTime: string | null; endTime: string | null } {
  const explicitStart = typeof body.start_time === 'string' ? body.start_time : null;
  const explicitEnd = typeof body.end_time === 'string' ? body.end_time : null;
  if (explicitStart !== null || explicitEnd !== null) {
    return { startTime: explicitStart, endTime: explicitEnd };
  }
  if (typeof body.time === 'string' && body.time.trim()) {
    const { start, end } = parseTime(body.time);
    return { startTime: start, endTime: end };
  }
  return { startTime: null, endTime: null };
}
