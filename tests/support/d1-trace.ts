/**
 * D1 往返追蹤：包住測試用 D1，記錄每次 first/all/run/raw/batch 的 SQL、種類與「第幾波」。
 * 每次呼叫先睡 latencyMs（模擬網路往返），所以「回應回來時已完成的最大波數」＝關鍵路徑上的循序往返數；
 * 同一波 = 同時發出（Promise.all／同一個 batch）。回應之後才完成的呼叫（waitUntil）不計入關鍵路徑。
 */
export interface TraceCall { op: string; sql: string; write: boolean; wave: number; endedAt: number }

export function traceD1(real: D1Database, latencyMs = 25, slow?: (sql: string) => number) {
  const calls: TraceCall[] = [];
  let completedWave = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

  async function record<T>(op: string, sql: string, write: boolean, fn: () => Promise<T>): Promise<T> {
    const call: TraceCall = { op, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 90), write, wave: completedWave + 1, endedAt: 0 };
    calls.push(call);
    await sleep(latencyMs + (slow?.(sql) ?? 0));
    try { return await fn(); } finally { call.endedAt = performance.now(); completedWave = Math.max(completedWave, call.wave); }
  }

  const wrapStmt = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...p: unknown[]) => wrapStmt(sql, stmt.bind(...p)),
      first: (...a: unknown[]) => record('first', sql, isWrite(sql), () => (stmt.first as (...x: unknown[]) => Promise<unknown>)(...a)),
      all: () => record('all', sql, isWrite(sql), () => stmt.all()),
      run: () => record('run', sql, isWrite(sql), () => stmt.run()),
      raw: () => record('raw', sql, isWrite(sql), () => stmt.raw()),
      __exec: (stmt as unknown as { __exec: () => unknown }).__exec,
      __sql: sql,
    };
    return w as unknown as D1PreparedStatement;
  };

  const db = {
    prepare: (sql: string) => wrapStmt(sql, real.prepare(sql)),
    batch: (stmts: Array<{ __sql: string }>) =>
      record('batch', stmts.map((s) => s.__sql).join(' ;; '), stmts.some((s) => isWrite(s.__sql)), () => real.batch(stmts as never)),
    exec: (sql: string) => real.exec(sql),
  } as unknown as D1Database;

  return {
    db,
    calls,
    /** 回應回來那一刻之前已完成的呼叫：{ roundTrips: 循序往返數, queries: 呼叫數, writes } */
    critical(responseAt: number) {
      const done = calls.filter((c) => c.endedAt > 0 && c.endedAt <= responseAt);
      return { roundTrips: Math.max(0, ...done.map((c) => c.wave)), queries: done.length, writes: done.filter((c) => c.write).length };
    },
  };
}

/** 假的 ExecutionContext：收 waitUntil 的 promise，測試用 flush() 等它們全部完成後才斷言。 */
export function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext,
    flush: async () => { await Promise.allSettled(pending); },
  };
}
