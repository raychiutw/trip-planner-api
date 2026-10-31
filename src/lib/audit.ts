import { detectGarbledText } from './validate';

/** Server-side reason set for companion-path failures (poi-favorites-rename §4 / D10). */
export type CompanionFailureReason =
  | 'invalid_request_id'
  | 'status_completed'
  | 'submitter_unknown'
  | 'self_reported_scope'
  | 'client_unauthorized'
  | 'quota_exceeded';

export async function logAudit(db: D1Database, opts: {
  tripId: string;
  tableName: string;
  recordId: number | null;
  action: 'insert' | 'update' | 'delete' | 'error';
  changedBy: string;
  requestId?: number | null;
  diffJson?: string;
  snapshot?: string;
  companionFailureReason?: CompanionFailureReason;
}) {
  let finalDiffJson = opts.diffJson ?? null;
  if (finalDiffJson && detectGarbledText(finalDiffJson)) {
    try {
      const parsed = JSON.parse(finalDiffJson);
      parsed._encoding_warning = true;
      finalDiffJson = JSON.stringify(parsed);
    } catch { /* keep original */ }
  }

  try {
    await db.prepare(
      'INSERT INTO audit_log (trip_id, table_name, record_id, action, changed_by, request_id, diff_json, snapshot, companion_failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      opts.tripId,
      opts.tableName,
      opts.recordId,
      opts.action,
      opts.changedBy,
      opts.requestId ?? null,
      finalDiffJson,
      opts.snapshot ?? null,
      opts.companionFailureReason ?? null,
    ).run();
  } catch (err) {
    console.error('[audit] logAudit failed (non-fatal):', err);
  }
}

/**
 * recordEmailEvent — log email send / trigger fetch outcome to audit_log.
 *
 * Reuses existing audit_log table (Q11 decision in
 * 2026-05-02-email-and-trigger-silent-fail-fix proposal). Uses
 * `table_name='email'` to namespace; uses `action='insert'` for all events
 * (audit_log CHECK constraint only allows insert/update/delete; success vs
 * failure is encoded in diff_json.status).
 *
 * For verify/forgot/reset (no trip context) tripId defaults to 'system'.
 * For invitation / trigger-failed pass real tripId.
 */
export async function recordEmailEvent(db: D1Database, opts: {
  template: string;        // 'verification' | 'forgot-password' | 'reset-password-confirm' | 'invitation' | 'trigger'
  recipient: string;
  status: 'sent' | 'failed' | 'config-missing' | 'trigger-failed';
  error?: string;
  tripId?: string;
  triggeredBy?: string;
  latencyMs?: number;
}) {
  const diff = JSON.stringify({
    template: opts.template,
    recipient: opts.recipient,
    status: opts.status,
    error: opts.error ?? null,
    latency_ms: opts.latencyMs ?? null,
  });
  await logAudit(db, {
    tripId: opts.tripId ?? 'system',
    tableName: 'email',
    recordId: null,
    action: 'insert',
    changedBy: opts.triggeredBy ?? 'system',
    diffJson: diff,
  });
}

export function computeDiff(oldRow: Record<string, unknown>, newFields: Record<string, unknown>): string {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(newFields)) {
    const oldVal = oldRow[key];
    const newVal = newFields[key];
    const oldStr = typeof oldVal === 'object' && oldVal !== null ? JSON.stringify(oldVal) : oldVal;
    const newStr = typeof newVal === 'object' && newVal !== null ? JSON.stringify(newVal) : newVal;
    if (oldStr !== newStr) {
      diff[key] = { old: oldVal, new: newVal };
    }
  }
  return JSON.stringify(diff);
}
