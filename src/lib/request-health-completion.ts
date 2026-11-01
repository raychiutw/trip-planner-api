/**
 * Parse trip_requests.reply as JSON array of findings and write into
 * trip_health_reports. Reply 應該是純 JSON array（per HEALTH_CHECK_MESSAGE
 * 指示），但 Claude 偶爾會包 ```json fence 或加 prose — 寬鬆 extract 第一個
 * `[...]` block。
 */
export async function applyHealthCheckCompletion(
  db: D1Database,
  tripId: string,
  requestId: number,
  request: Record<string, unknown>,
) {
  const failed = request.status === 'failed';
  const needsConsent = request.terminal_reason === 'needs_consent';
  const reply = typeof request.reply === 'string' ? request.reply : '';
  // 只有 pending 可套用成果。重試從已保存的報告重建摘要，不能重新解析摘要為空 findings。
  await db.prepare(
    `UPDATE trip_health_reports
       SET status = ?,
           findings_json = CASE WHEN ? = 1 THEN findings_json ELSE ? END,
           error_message = ?,
           completed_at = CASE WHEN ? = 1 THEN completed_at ELSE datetime('now') END
     WHERE trip_id = ? AND request_id = ? AND status = 'pending'`,
  ).bind(
    failed ? 'failed' : 'completed',
    failed ? 1 : 0,
    JSON.stringify(parseFindings(reply)),
    failed ? (needsConsent ? '需要行程擁有者授權 AI 才能執行健檢' : reply || '健檢失敗').slice(0, 500) : null,
    failed ? 1 : 0,
    tripId, requestId,
  ).run();
  if (needsConsent) return; // request 保留完整的授權操作指引。
  const report = await db.prepare(
    'SELECT status, findings_json, error_message FROM trip_health_reports WHERE trip_id = ? AND request_id = ?',
  ).bind(tripId, requestId).first<{ status: string; findings_json: string | null; error_message: string | null }>();
  if (!report) return;
  const summary = report.status === 'failed'
    ? `AI 健檢失敗 — ${(report.error_message || '健檢失敗').slice(0, 200)}\n\n可重新觸發：[前往健檢報告](/trip/${tripId}/health)`
    : buildHealthCheckSummary(parseFindings(report.findings_json || '[]'), tripId);
  await rewriteRequestReply(db, requestId, summary);
}

/**
 * v2.31.18: AI 健檢完成後改寫 trip_requests.reply 為 user-friendly summary。
 * Chat UI 把 reply 當 markdown 渲染，原 raw JSON array 對 user 無意義。
 */
function buildHealthCheckSummary(findings: unknown[], tripId: string): string {
  const reportLink = `[前往健檢報告 →](/trip/${tripId}/health)`;
  if (findings.length === 0) {
    return `AI 健檢完成 — 行程沒發現問題。\n\n${reportLink}`;
  }
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const sev = (f as { severity?: string })?.severity;
    if (sev === 'high' || sev === 'medium' || sev === 'low') counts[sev]++;
  }
  const breakdown = (
    [
      counts.high > 0 ? `high ${counts.high}` : null,
      counts.medium > 0 ? `medium ${counts.medium}` : null,
      counts.low > 0 ? `low ${counts.low}` : null,
    ].filter(Boolean) as string[]
  ).join(' · ');
  return `AI 健檢完成 — 發現 ${findings.length} 個 finding（${breakdown}）。\n\n${reportLink}`;
}

async function rewriteRequestReply(db: D1Database, requestId: number, newReply: string): Promise<void> {
  await db
    .prepare(`UPDATE trip_requests SET reply = ? WHERE id = ?`)
    .bind(newReply, requestId)
    .run();
}

function parseFindings(reply: string): unknown[] {
  if (!reply.trim()) return [];
  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(reply);
    if (Array.isArray(parsed)) return sanitizeFindings(parsed);
  } catch {
    // fall through to bracket extraction
  }
  // Extract first [...] block from prose/fence wrapper
  const match = reply.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return sanitizeFindings(parsed);
    } catch {
      // give up
    }
  }
  return [];
}

// v2.31.74: backend post-process sanitizer — 不靠 LLM 100% 服從 prompt 用詞規定。
// v2.31.65 prompt 改強化用詞 instruction，但 prod QA (沖繩七日遊行程表) 仍有 1/7
// finding suggestion 含「新增早餐 entry 並掛具體店家」schema 詞 leak。Regex 強制替換。
const SCHEMA_WORD_RULES: Array<[RegExp, string]> = [
  // 帶數字單位（先處理避免被獨立 min/km 規則吃掉）
  [/(\d+)\s*min\b/g, '$1 分鐘'],
  [/(\d+)\s*km\b/g, '$1 公里'],
  // schema 借詞（皆 word-boundary，case-insensitive 處理 Claude 大小寫不一致）
  [/\bentries\b/gi, '景點'],
  [/\bentry\b/gi, '景點'],
  [/\bPOIs\b/g, '景點'],
  [/\bPOI\b/g, '景點'],
  [/\bcheck-in\b/gi, '入住'],
  [/\bcheck in\b/gi, '入住'],
  [/\bbuffer\b/gi, '緩衝時間'],
  [/\brating\b/gi, '評分'],
  [/\btravel\s+min\b/gi, '移動時間'],
  [/\btravel\b/gi, '移動'],
  [/\bpolyline\b/gi, '路線'],
  [/\balt\b/gi, '替代'],
];

export function sanitizeSchemaWords(s: string): string {
  let r = s;
  for (const [re, rep] of SCHEMA_WORD_RULES) r = r.replace(re, rep);
  return r;
}

function sanitizeFindings(arr: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const sev = typeof f.severity === 'string' ? f.severity.toLowerCase() : '';
    if (sev !== 'high' && sev !== 'medium' && sev !== 'low') continue;
    const title = typeof f.title === 'string' ? sanitizeSchemaWords(f.title.slice(0, 60)) : '';
    const description = typeof f.description === 'string' ? sanitizeSchemaWords(f.description.slice(0, 400)) : '';
    if (!title) continue;
    const cleaned: Record<string, unknown> = { severity: sev, title, description };

    // v2.31.1 Phase 2: dimension + suggestion 欄位（皆可選，僅當合法值時保留）
    const VALID_DIMENSIONS = ['timing', 'distance', 'meals', 'sights', 'hotel'] as const;
    if (typeof f.dimension === 'string') {
      const dim = f.dimension.toLowerCase();
      if ((VALID_DIMENSIONS as readonly string[]).includes(dim)) {
        cleaned.dimension = dim;
      }
    }
    if (typeof f.suggestion === 'string' && f.suggestion.trim()) {
      cleaned.suggestion = sanitizeSchemaWords(f.suggestion.slice(0, 200));
    }

    const action = f.action_target && typeof f.action_target === 'object'
      ? f.action_target as Record<string, unknown>
      : null;
    if (action) {
      const day = typeof action.day === 'number' ? action.day : null;
      const entryId = typeof action.entry_id === 'number' ? action.entry_id : null;
      if (day !== null || entryId !== null) {
        cleaned.action_target = { ...(day !== null && { day }), ...(entryId !== null && { entry_id: entryId }) };
      }
    }
    out.push(cleaned);
  }
  return out;
}
