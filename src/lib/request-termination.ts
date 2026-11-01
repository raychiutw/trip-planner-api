import { logAudit, computeDiff } from './audit';
import { AppError } from '../errors';
import { sanitizeReply } from './validate';
import { applyHealthCheckCompletion } from './request-health-completion';
import { applyNotesGenerationCompletion, expiredNoteAiRequests, markNoteAiJobProcessing, type NoteAiDocType, type NoteAiJobStatus } from './note-ai';

/**
 * Request 終結 — 見 docs/adr/0007-request-termination-cancel-and-reap.md
 *
 * 一筆 request 結束時，「結束了沒」與「為什麼結束」是兩個欄位：
 *   status          — open / processing / completed / failed（migration 0049 的四值 CHECK）
 *   terminal_reason — 本檔的 TERMINAL_REASONS（migration 0092，刻意無 CHECK constraint）
 */

export const TERMINAL_REASONS = ['cancelled', 'timed_out', 'error', 'needs_consent'] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

/** 走到底、不會再有 worker 處理的 status。open / processing 是「還在跑」。 */
export const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/**
 * 牆鐘兜底門檻。
 *
 * ⚠️ **必須大於 tripline-api-server.ts 的 ORPHAN_MAX_AGE_MS（90 分鐘）**，這條是
 * load-bearing 不是保守取值：短於它，健康 session 還在工作時 request 就被標終結 →
 * session 的 tripHasPending() 看不到待處理 → 自己 kill-session → 反覆重做永遠做不完，
 * 完全重演 #237（v2.55.29 修的那個 30 分鐘 orphan timeout 誤殺）。
 *
 * 這層只是「api-server 自己掛掉／mac mini 離線時不要讓 row 永遠卡著」的安全網。
 * 使用者體驗不靠它扛 —— 靠 ChatPage 一送出就在的「停止等待」鍵。
 */
export const REQUEST_STALE_MINUTES = 100;

interface RequestRow {
  status?: unknown;
  [key: string]: unknown;
}

/**
 * Lazy 收屍：非終結 request 停滯超過 REQUEST_STALE_MINUTES 就地標 timed_out。
 *
 * 只掛 `GET /requests/:id` —— `useRequestSSE` 的 30 秒 always-on polling 打的就是它。
 * **不掛 SSE events**：那條 stream 30 分鐘就關（MAX_DURATION_MS），本來就活不到 100
 * 分鐘，掛上去只是多一條打不到的路徑。沒人在看的殭屍收不到，但那種情況隊列本來就不會
 * 動 —— 能推進隊列的 api-server 若活著，第一層早就收了。
 *
 * 齡用 `COALESCE(updated_at, created_at)`：api-server 從沒接手過的 request 其
 * `updated_at` 是 NULL（PATCH 才會寫），只看 updated_at 會讓它永遠不算齡。
 *
 * **刻意不寫 reply** —— 那格留給 ADR-0007 的「遲到完成」。UI 文案由 terminal_reason 驅動。
 *
 * 收屍沿用共用終結與收尾；活動時間的 SQL 比對避免誤收剛恢復活動的 request。
 */
export async function reapIfStale<T extends RequestRow | null>(
  db: D1Database,
  id: number | string,
  row: T,
): Promise<T> {
  if (!row) return row;
  if (TERMINAL_STATUSES.has(row.status as string)) {
    await settleLinkedRequest(db, row);
    const current = await db.prepare('SELECT * FROM trip_requests WHERE id = ?').bind(id).first();
    return (current as T) ?? row;
  }
  const stale = await db
    .prepare(
      `SELECT * FROM trip_requests WHERE id = ?
          AND status IN ('open', 'processing')
          AND COALESCE(updated_at, created_at) <= datetime('now', ?)`,
    )
    .bind(id, `-${REQUEST_STALE_MINUTES} minutes`)
    .first<Record<string, unknown>>();
  if (!stale) return row;
  return await updateRequest(db, stale, { status: 'failed', terminalReason: 'timed_out' }, {
    changedBy: 'system:request-timeout',
    ifActivityUnchanged: String(stale.updated_at ?? stale.created_at),
  }) as T;
}

export interface RequestPatch {
  reply?: string;
  status?: string;
  processed_by?: string;
  terminalReason?: string;
}

/** 期限判定由筆記 domain 提供；每筆 request 都先終結，再更新自己的 job。 */
export async function expireNoteAiJobs(db: D1Database, tripId?: string, docType?: NoteAiDocType): Promise<void> {
  for (const row of await expiredNoteAiRequests(db, tripId, docType)) {
    await updateRequest(db, row, {
      status: 'failed', terminalReason: 'timed_out',
      ...(row.reply == null ? { reply: 'AI 生成超過 10 分鐘' } : {}),
    }, { changedBy: 'system:notes-timeout', onlyIfActive: true });
  }
}

interface RequestUpdateOptions {
  changedBy?: string;
  onlyIfActive?: boolean;
  /** 逾時入口讀取後，活動時間若已改變便不套用這次更新。 */
  ifActivityUnchanged?: string;
}

/** 已授權的入口共用：先更新 request，再獨立嘗試關聯收尾；重送可補做。 */
export async function updateRequest(
  db: D1Database,
  oldRow: Record<string, unknown>,
  body: RequestPatch,
  options: RequestUpdateOptions = {},
): Promise<Record<string, unknown>> {
  const id = String(oldRow.id);
  const updates: string[] = [];
  const values: string[] = [];

  if (body.reply !== undefined) {
    updates.push('reply = ?');
    values.push(sanitizeReply(body.reply));
  }

  if (body.status !== undefined) {
    const STATUS_ORDER = ['open', 'processing', 'completed', 'failed'] as const;
    if (!STATUS_ORDER.includes(body.status as typeof STATUS_ORDER[number])) {
      throw new AppError('DATA_VALIDATION', 'status 必須是 open、processing、completed 或 failed');
    }

    const oldStatus = oldRow.status as typeof STATUS_ORDER[number];
    const nextStatus = body.status as typeof STATUS_ORDER[number];
    const backwards = STATUS_ORDER.indexOf(nextStatus) < STATUS_ORDER.indexOf(oldStatus);
    if (backwards && !(TERMINAL_STATUSES.has(oldStatus) && TERMINAL_STATUSES.has(nextStatus))) {
      throw new AppError('DATA_VALIDATION', `status 不可從 ${oldStatus} 退回 ${nextStatus}`);
    }
    // SQL 判斷寫入當下的狀態，併發或重送終結通知都保留首次終結。
    updates.push("status = CASE WHEN status IN ('completed', 'failed') THEN status ELSE ? END");
    values.push(body.status);
  }

  if (body.processed_by !== undefined) {
    const VALID_PROCESSORS = ['api', 'job'] as const;
    if (!VALID_PROCESSORS.includes(body.processed_by as typeof VALID_PROCESSORS[number])) {
      throw new AppError('DATA_VALIDATION', 'processed_by 必須是 api 或 job');
    }
    updates.push('processed_by = ?');
    values.push(body.processed_by);
  }

  // ADR-0007：終結原因獨立成欄（不進 status 的 CHECK — trip_requests 有 4 張 children
  // FK，改 CHECK 要走 migrations/0047 的 backup-restore，那條路造成過 prod 資料全失）。
  // 值域在這裡把關，migration 刻意不加 CHECK constraint（見 0092 的說明）。
  // Body 用 camelCase `terminalReason` 對齊 POST /api/requests 與 response shape；
  // `processed_by` 的 snake 是既有包袱，不擴散。
  if (body.terminalReason !== undefined) {
    if (!TERMINAL_REASONS.includes(body.terminalReason as TerminalReason)) {
      throw new AppError('DATA_VALIDATION', `terminalReason 必須是 ${TERMINAL_REASONS.join('、')}`);
    }
    updates.push("terminal_reason = CASE WHEN status IN ('completed', 'failed') THEN terminal_reason ELSE ? END");
    values.push(body.terminalReason);
  }

  if (updates.length === 0) {
    throw new AppError('DATA_VALIDATION', '沒有要更新的欄位');
  }

  // 筆記期限也適用於遲到的 worker 通知；期限及 generation 判斷由筆記 domain 持有。
  // expiry 自己送 failed，所以不會再次進入這個檢查。
  if (!TERMINAL_STATUSES.has(String(oldRow.status)) && body.status !== 'failed') {
    await expireNoteAiJobs(db, String(oldRow.trip_id));
  }

  // 每次 PATCH 自動更新 updated_at
  updates.push("updated_at = datetime('now')");

  values.push(id);
  const activityGuard = options.ifActivityUnchanged === undefined
    ? '' : ' AND COALESCE(updated_at, created_at) = ?';
  const activeGuard = options.onlyIfActive ? " AND status IN ('open', 'processing')" : '';
  if (options.ifActivityUnchanged !== undefined) values.push(options.ifActivityUnchanged);
  const result = await db
    .prepare(`UPDATE trip_requests SET ${updates.join(', ')} WHERE id = ?${activityGuard}${activeGuard} RETURNING *`)
    .bind(...values)
    .first();

  if (!result) {
    if (options.ifActivityUnchanged !== undefined || options.onlyIfActive) {
      const current = await db.prepare('SELECT * FROM trip_requests WHERE id = ?').bind(id).first<Record<string, unknown>>();
      if (current) {
        if (options.onlyIfActive && TERMINAL_STATUSES.has(String(current.status))) await settleLinkedRequest(db, current);
        return current;
      }
    }
    throw new AppError('DATA_NOT_FOUND', '找不到該請求');
  }

  const tripId = (result as Record<string, unknown>).trip_id as string;
  const newFields = Object.fromEntries(
    Object.keys(body).filter((key) => body[key as keyof RequestPatch] !== undefined).map((key) => {
      const column = key === 'terminalReason' ? 'terminal_reason' : key;
      return [column, (result as Record<string, unknown>)[column]];
    }),
  );
  await logAudit(db, {
    tripId,
    tableName: 'trip_requests',
    recordId: Number(id),
    action: 'update',
    changedBy: options.changedBy ?? 'system:request-termination',
    diffJson: computeDiff(oldRow, newFields),
  });

  await settleLinkedRequest(db, result as Record<string, unknown>);

  return result as Record<string, unknown>;
}

/** 關聯收尾也供終結後的 GET 重試；不改 request 的狀態或原因。 */
async function settleLinkedRequest(db: D1Database, result: Record<string, unknown>): Promise<void> {
  const id = Number(result.id);
  const tripId = result.trip_id as string;
  // AI 健檢 hook：v2.33.102 CR-8 confused-deputy fix — 之前單靠 `message.startsWith([AI 健檢])`
  // 認 health-check request。任何 user 在 chat 打 `[AI 健檢] ...` 都能觸發 hook，
  // 讓 service token PATCH reply 後被誤 parse 成 findings → UPSERT trip_health_reports
  // 覆蓋（或產生）該 trip 的 report row。改用 trip_health_reports.request_id linkage
  // 當 authoritative signal（POST /trips/:id/health-check 唯一寫入點）。
  const newStatus = (result as Record<string, unknown>).status as string;
  if (newStatus === 'processing') {
    await markNoteAiJobProcessing(db, Number(id), tripId);
  }
  if (newStatus === 'completed' || newStatus === 'failed') {
    try {
      const linked = await db
        .prepare('SELECT 1 FROM trip_health_reports WHERE request_id = ? AND trip_id = ? LIMIT 1')
        .bind(Number(id), tripId)
        .first();
      if (linked) {
        await applyHealthCheckCompletion(db, tripId, Number(id), result as Record<string, unknown>);
      }
    } catch (hookErr) {
      console.error('[requests] health-check completion hook failed:', hookErr);
    }

    // v2.34.x 行程筆記 PR10: notes generation linkage hook
    // 對齊 CR-8 confused-deputy fix — SELECT linkage row 是 authoritative signal
    // (POST /trips/:id/notes/:type/generate 唯一寫入點，service token 不會誤觸發)
    try {
      const notesJob = await db
        .prepare(
          `SELECT id, request_id, trip_id, doc_type, generation, status
           FROM trip_note_ai_jobs WHERE request_id = ? AND trip_id = ? LIMIT 1`,
        )
        .bind(Number(id), tripId)
        .first<{
          id: number;
          request_id: number;
          trip_id: string;
          doc_type: NoteAiDocType;
          generation: number;
          status: NoteAiJobStatus;
        }>();
      if (notesJob) {
        await applyNotesGenerationCompletion(
          db,
          tripId,
          Number(id),
          notesJob,
          result as Record<string, unknown>,
        );
      }
    } catch (hookErr) {
      console.error('[requests] notes-generation completion hook failed:', hookErr);
    }
  }

}
