import { logAudit } from './audit';

export const NOTE_AI_DOC_TYPES = ['lodging-tips', 'tips', 'emergency'] as const;
export type NoteAiDocType = (typeof NOTE_AI_DOC_TYPES)[number];
export type NoteAiJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'timed_out';

export const PRETRIP_AI_SOURCES: Record<Exclude<NoteAiDocType, 'emergency'>, string> = {
  'lodging-tips': 'lodging-tips',
  tips: 'general-tips',
};

const EMERGENCY_KINDS = [
  'personal', 'embassy', 'police', 'medical', 'insurance', 'hotel', 'other',
] as const;

type ErrorCode =
  | 'NOTES_AI_INVALID_OUTPUT'
  | 'NOTES_AI_NO_VALID_ITEMS'
  | 'NOTES_AI_JOB_STALE'
  | 'NOTES_AI_APPLY_FAILED';

type ParsedPretripItem = {
  section: string;
  title: string;
  content: string;
  semanticKey: string;
};

type ParsedEmergencyItem = {
  name: string;
  relationship: string;
  phone: string;
  kind: typeof EMERGENCY_KINDS[number];
  semanticKey: string;
};

type ParsedItem = ParsedPretripItem | ParsedEmergencyItem;

type ParseResult =
  | { ok: true; items: ParsedItem[]; suppressedCount: number }
  | { ok: false; code: Extract<ErrorCode, 'NOTES_AI_INVALID_OUTPUT' | 'NOTES_AI_NO_VALID_ITEMS'>; message: string };

interface NoteAiJobRow {
  id: number;
  request_id: number;
  trip_id: string;
  doc_type: NoteAiDocType;
  generation: number;
  status: NoteAiJobStatus;
}

function compact(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hant')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function pretripTopic(section: string, title: string): string {
  const text = compact(`${section}${title}`);
  const topics: Array<[RegExp, string]> = [
    [/貨幣|匯率|現金|信用卡|atm/, 'currency'],
    [/插頭|插座|電壓|變壓器|轉接/, 'electricity'],
    [/簽證|護照|入境|海關/, 'entry'],
    [/通訊|網路|sim|esim|漫遊|wifi/, 'connectivity'],
    [/禮儀|禁忌|文化/, 'etiquette'],
    [/治安|詐騙|安全/, 'safety'],
    [/退稅|購物/, 'tax'],
    [/早餐/, 'breakfast'],
    [/超商|便利店/, 'convenience-store'],
    [/寄物|行李/, 'luggage'],
    [/停車/, 'parking'],
    [/退房|入住|飯店|住宿/, 'lodging'],
  ];
  return topics.find(([pattern]) => pattern.test(text))?.[1] ?? compact(`${section}:${title}`);
}

export function semanticKeyForPretrip(
  docType: Exclude<NoteAiDocType, 'emergency'>,
  section: string,
  title: string,
): string {
  return `${docType}:${pretripTopic(section, title)}`;
}

export function semanticKeyForEmergency(kind: string, name: string, phone = ''): string {
  if (kind === 'police' || kind === 'medical' || kind === 'embassy' || kind === 'insurance' || kind === 'hotel') {
    return `emergency:${kind}`;
  }
  return `emergency:${compact(name)}:${compact(phone)}`;
}

export function isNoteAiDocType(value: string): value is NoteAiDocType {
  return (NOTE_AI_DOC_TYPES as readonly string[]).includes(value);
}

function parseItems(docType: NoteAiDocType, reply: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    return {
      ok: false,
      code: 'NOTES_AI_INVALID_OUTPUT',
      message: 'AI 回覆不是有效的 JSON array',
    };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'NOTES_AI_INVALID_OUTPUT',
      message: 'AI 回覆必須是 JSON array',
    };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      code: 'NOTES_AI_NO_VALID_ITEMS',
      message: 'AI 沒有回傳任何項目',
    };
  }

  const parsed: ParsedItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') {
      return {
        ok: false,
        code: 'NOTES_AI_INVALID_OUTPUT',
        message: 'AI 回覆包含非物件項目',
      };
    }
    const item = value as Record<string, unknown>;
    if (docType === 'emergency') {
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 100) : '';
      const phone = typeof item.phone === 'string' ? item.phone.trim().slice(0, 50) : '';
      const relationship = typeof item.relationship === 'string'
        ? item.relationship.trim().slice(0, 100)
        : '';
      const kind = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '';
      if (!name || !phone || !(EMERGENCY_KINDS as readonly string[]).includes(kind)) {
        return {
          ok: false,
          code: 'NOTES_AI_INVALID_OUTPUT',
          message: '緊急聯絡項目缺少 name、phone 或 kind 不合法',
        };
      }
      parsed.push({
        name,
        phone,
        relationship,
        kind: kind as ParsedEmergencyItem['kind'],
        semanticKey: semanticKeyForEmergency(kind, name, phone),
      });
      continue;
    }

    const section = typeof item.section === 'string' ? item.section.trim().slice(0, 50) : '';
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 100) : '';
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 1000) : '';
    if (!section || !title || !content) {
      return {
        ok: false,
        code: 'NOTES_AI_INVALID_OUTPUT',
        message: '行前須知項目缺少 section、title 或 content',
      };
    }
    parsed.push({
      section,
      title,
      content,
      semanticKey: semanticKeyForPretrip(docType, section, title),
    });
  }

  const unique = new Map<string, ParsedItem>();
  for (const item of parsed) {
    if (!unique.has(item.semanticKey)) unique.set(item.semanticKey, item);
  }
  return {
    ok: true,
    items: [...unique.values()],
    suppressedCount: parsed.length - unique.size,
  };
}

/** 筆記自己的期限與適用範圍；由 request coordinator 依序終結、收尾。 */
export async function expiredNoteAiRequests(
  db: D1Database,
  tripId?: string,
  docType?: NoteAiDocType,
): Promise<Array<Record<string, unknown>>> {
  const scope: string[] = [];
  const values: string[] = [];
  if (tripId) { scope.push('j.trip_id = ?'); values.push(tripId); }
  if (docType) { scope.push('j.doc_type = ?'); values.push(docType); }
  const rows = await db.prepare(
    `SELECT r.* FROM trip_requests r JOIN trip_note_ai_jobs j ON j.request_id = r.id AND j.trip_id = r.trip_id
     WHERE ((j.status IN ('pending', 'processing') AND j.timeout_at <= datetime('now'))
       OR (j.status = 'timed_out' AND j.error_code = 'NOTES_AI_JOB_STALE' AND r.status IN ('open', 'processing')))
       ${scope.length ? `AND ${scope.join(' AND ')}` : ''}`,
  ).bind(...values).all<Record<string, unknown>>();
  return rows.results ?? [];
}

async function expireNoteAiJob(db: D1Database, requestId: number, tripId: string): Promise<void> {
  await db.prepare(
    `UPDATE trip_note_ai_jobs
     SET status = 'timed_out', error_code = 'NOTES_AI_JOB_STALE',
         error_message = 'AI 生成逾時（超過 100 分鐘未回報）', completed_at = datetime('now')
     WHERE request_id = ? AND trip_id = ? AND status IN ('pending', 'processing')
       AND timeout_at <= datetime('now')`,
  ).bind(requestId, tripId).run();
}

export async function markNoteAiJobProcessing(
  db: D1Database,
  requestId: number,
  tripId: string,
): Promise<void> {
  await expireNoteAiJob(db, requestId, tripId);
  await db.prepare(
    `UPDATE trip_note_ai_jobs
     SET status = 'processing', started_at = COALESCE(started_at, datetime('now'))
     WHERE request_id = ? AND trip_id = ? AND status = 'pending'`,
  ).bind(requestId, tripId).run();
}

async function rewriteRequestReply(
  db: D1Database,
  requestId: number,
  reply: string,
): Promise<void> {
  await db.prepare('UPDATE trip_requests SET reply = ? WHERE id = ?').bind(reply, requestId).run();
}

async function failJob(
  db: D1Database,
  job: NoteAiJobRow,
  code: ErrorCode,
  message: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE trip_note_ai_jobs
     SET status = 'failed', error_code = ?, error_message = ?, completed_at = datetime('now')
     WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')`,
  ).bind(code, message.slice(0, 500), job.id, job.generation).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function applyNotesGenerationCompletion(
  db: D1Database,
  tripId: string,
  requestId: number,
  job: NoteAiJobRow,
  request: Record<string, unknown>,
): Promise<void> {
  await expireNoteAiJob(db, requestId, tripId);
  const active = await db.prepare(
    `SELECT id, request_id, trip_id, doc_type, generation, status
     FROM trip_note_ai_jobs
     WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')`,
  ).bind(job.id, job.generation).first<NoteAiJobRow>();
  if (!active) return;

  if (request.status === 'failed') {
    const needsConsent = request.terminal_reason === 'needs_consent';
    const message = needsConsent ? '需要行程擁有者授權 AI 才能生成' : typeof request.reply === 'string' && request.reply.trim()
      ? request.reply.trim()
      : 'AI 生成失敗';
    if (await failJob(db, active, 'NOTES_AI_APPLY_FAILED', message)) {
      if (needsConsent) return; // request 保留完整的授權操作指引。
      await rewriteRequestReply(
        db,
        requestId,
        `AI 生成失敗 — ${message.slice(0, 200)}\n\n可重試：[前往行程筆記 →](/trip/${tripId}/notes)`,
      );
    }
    return;
  }

  const parsed = parseItems(active.doc_type, typeof request.reply === 'string' ? request.reply : '');
  if (!parsed.ok) {
    if (await failJob(db, active, parsed.code, parsed.message)) {
      await rewriteRequestReply(
        db,
        requestId,
        `AI 生成失敗 — ${parsed.message}\n\n可重試：[前往行程筆記 →](/trip/${tripId}/notes)`,
      );
    }
    return;
  }

  const exclusions = await db.prepare(
    `SELECT semantic_key FROM trip_note_ai_exclusions WHERE trip_id = ? AND doc_type = ?`,
  ).bind(tripId, active.doc_type).all<{ semantic_key: string }>();
  const excludedKeys = new Set((exclusions.results ?? []).map((row) => row.semantic_key));

  let manualRows: Array<Record<string, unknown>>;
  let replacedRows: Array<Record<string, unknown>>;
  let maxOrder: number;
  if (active.doc_type === 'emergency') {
    const [manual, replaced, max] = await Promise.all([
      db.prepare(
        `SELECT * FROM trip_emergency_contacts WHERE trip_id = ? AND managed_by = 'human'`,
      ).bind(tripId).all<Record<string, unknown>>(),
      db.prepare(
        `SELECT * FROM trip_emergency_contacts
         WHERE trip_id = ? AND origin = 'ai' AND managed_by = 'ai'`,
      ).bind(tripId).all<Record<string, unknown>>(),
      db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS m FROM trip_emergency_contacts
         WHERE trip_id = ? AND NOT (origin = 'ai' AND managed_by = 'ai')`,
      ).bind(tripId).first<{ m: number }>(),
    ]);
    manualRows = manual.results ?? [];
    replacedRows = replaced.results ?? [];
    maxOrder = max?.m ?? -1;
  } else {
    const aiSource = PRETRIP_AI_SOURCES[active.doc_type];
    const [manual, replaced, max] = await Promise.all([
      db.prepare(
        `SELECT * FROM trip_pretrip_notes
         WHERE trip_id = ? AND managed_by = 'human'
           AND (origin = 'human' OR ai_source = ?)`,
      ).bind(tripId, aiSource).all<Record<string, unknown>>(),
      db.prepare(
        `SELECT * FROM trip_pretrip_notes
         WHERE trip_id = ? AND ai_source = ? AND origin = 'ai' AND managed_by = 'ai'`,
      ).bind(tripId, aiSource).all<Record<string, unknown>>(),
      db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS m FROM trip_pretrip_notes
         WHERE trip_id = ?
           AND NOT (ai_source = ? AND origin = 'ai' AND managed_by = 'ai')`,
      ).bind(tripId, aiSource).first<{ m: number }>(),
    ]);
    manualRows = manual.results ?? [];
    replacedRows = replaced.results ?? [];
    maxOrder = max?.m ?? -1;
  }

  const manualKeys = new Set(manualRows.map((row) => {
    if (typeof row.semantic_key === 'string' && row.semantic_key) {
      return active.doc_type !== 'emergency'
        && row.origin === 'human'
        && !row.semantic_key.startsWith('tips:')
        && !row.semantic_key.startsWith('lodging-tips:')
        ? `${active.doc_type}:${row.semantic_key}`
        : row.semantic_key;
    }
    if (active.doc_type === 'emergency') {
      return semanticKeyForEmergency(
        String(row.kind ?? 'other'),
        String(row.name ?? ''),
        String(row.phone ?? ''),
      );
    }
    return semanticKeyForPretrip(
      active.doc_type,
      String(row.section ?? ''),
      String(row.title ?? ''),
    );
  }));

  let duplicateExcludedCount = 0;
  let suppressedCount = parsed.suppressedCount;
  const accepted = parsed.items.filter((item) => {
    if (excludedKeys.has(item.semanticKey)) {
      duplicateExcludedCount++;
      return false;
    }
    if (manualKeys.has(item.semanticKey)) {
      suppressedCount++;
      return false;
    }
    return true;
  });

  const actor = typeof request.submitted_by === 'string' && request.submitted_by
    ? `ai:${request.submitted_by}`
    : 'system:ai';
  const statements: D1PreparedStatement[] = [];
  const manualKeyValues = [...manualKeys];
  const manualKeyGuard = manualKeyValues.length > 0
    ? `AND (semantic_key IS NULL OR semantic_key NOT IN (${manualKeyValues.map(() => '?').join(', ')}))`
    : '';
  if (active.doc_type === 'emergency') {
    statements.push(db.prepare(
      `DELETE FROM trip_emergency_contacts
       WHERE trip_id = ? AND origin = 'ai' AND managed_by = 'ai'
         AND EXISTS (
           SELECT 1 FROM trip_note_ai_jobs
           WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')
         )
         ${manualKeyGuard}`,
    ).bind(tripId, active.id, active.generation, ...manualKeyValues));
    accepted.forEach((item, index) => {
      const emergency = item as ParsedEmergencyItem;
      statements.push(db.prepare(
        `INSERT INTO trip_emergency_contacts
           (trip_id, sort_order, name, relationship, phone, kind,
            ai_generated, origin, managed_by, semantic_key)
         SELECT ?, ?, ?, ?, ?, ?, 1, 'ai', 'ai', ?
         WHERE EXISTS (
           SELECT 1 FROM trip_note_ai_jobs
           WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')
         )
           AND NOT EXISTS (
             SELECT 1 FROM trip_note_ai_exclusions
             WHERE trip_id = ? AND doc_type = 'emergency' AND semantic_key = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM trip_emergency_contacts
             WHERE trip_id = ? AND managed_by = 'human' AND semantic_key = ?
         )`,
      ).bind(
        tripId,
        maxOrder + index + 1,
        emergency.name,
        emergency.relationship,
        emergency.phone,
        emergency.kind,
        emergency.semanticKey,
        active.id,
        active.generation,
        tripId,
        emergency.semanticKey,
        tripId,
        emergency.semanticKey,
      ));
    });
  } else {
    const aiSource = PRETRIP_AI_SOURCES[active.doc_type];
    statements.push(db.prepare(
      `DELETE FROM trip_pretrip_notes
       WHERE trip_id = ? AND ai_source = ? AND origin = 'ai' AND managed_by = 'ai'
         AND EXISTS (
           SELECT 1 FROM trip_note_ai_jobs
           WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')
         )
         ${manualKeyGuard}`,
    ).bind(tripId, aiSource, active.id, active.generation, ...manualKeyValues));
    accepted.forEach((item, index) => {
      const pretrip = item as ParsedPretripItem;
      const humanTopic = pretrip.semanticKey.slice(active.doc_type.length + 1);
      statements.push(db.prepare(
        `INSERT INTO trip_pretrip_notes
           (trip_id, sort_order, section, title, content, ai_generated, ai_source,
            origin, managed_by, semantic_key)
         SELECT ?, ?, ?, ?, ?, 1, ?, 'ai', 'ai', ?
         WHERE EXISTS (
           SELECT 1 FROM trip_note_ai_jobs
           WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')
         )
           AND NOT EXISTS (
             SELECT 1 FROM trip_note_ai_exclusions
             WHERE trip_id = ? AND doc_type = ? AND semantic_key = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM trip_pretrip_notes
             WHERE trip_id = ? AND managed_by = 'human'
               AND (semantic_key = ? OR (origin = 'human' AND semantic_key = ?))
         )`,
      ).bind(
        tripId,
        maxOrder + index + 1,
        pretrip.section,
        pretrip.title,
        pretrip.content,
        aiSource,
        pretrip.semanticKey,
        active.id,
        active.generation,
        tripId,
        active.doc_type,
        pretrip.semanticKey,
        tripId,
        pretrip.semanticKey,
        humanTopic,
      ));
    });
  }
  statements.push(db.prepare(
    `UPDATE trip_note_ai_jobs
     SET status = 'completed',
         inserted_count = ?,
         replaced_count = ?,
         preserved_manual_count = ?,
         duplicate_excluded_count = ?,
         suppressed_count = ?,
         error_code = NULL,
         error_message = NULL,
         completed_at = datetime('now')
     WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')`,
  ).bind(
    accepted.length,
    replacedRows.length,
    manualRows.length,
    duplicateExcludedCount,
    suppressedCount,
    active.id,
    active.generation,
  ));

  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // D1 batch 已回滾；保留原始 reply 與待套用狀態，讓重送終結通知可補做。
    // 無效 AI 輸出仍走上方的 domain failure，不混同暫時性的資料庫故障。
    await db.prepare(
      `UPDATE trip_note_ai_jobs SET error_code = 'NOTES_AI_APPLY_FAILED', error_message = ?
       WHERE id = ? AND generation = ? AND status IN ('pending', 'processing')`,
    ).bind(message.slice(0, 500), active.id, active.generation).run();
    throw error;
  }

  const completion = results.at(-1);
  if (!completion || (completion.meta.changes ?? 0) === 0) return;

  const insertedCount = accepted.reduce(
    (count, _item, index) => count + (results[index + 1]?.meta.changes ?? 0),
    0,
  );
  const replacedCount = results[0]?.meta.changes ?? 0;
  if (insertedCount < accepted.length) {
    const currentExclusions = await db.prepare(
      `SELECT semantic_key FROM trip_note_ai_exclusions WHERE trip_id = ? AND doc_type = ?`,
    ).bind(tripId, active.doc_type).all<{ semantic_key: string }>();
    const currentExcludedKeys = new Set(
      (currentExclusions.results ?? []).map((row) => row.semantic_key),
    );
    accepted.forEach((item, index) => {
      if ((results[index + 1]?.meta.changes ?? 0) > 0) return;
      if (currentExcludedKeys.has(item.semanticKey)) duplicateExcludedCount++;
      else suppressedCount++;
    });
  }
  const preservedManual = active.doc_type === 'emergency'
    ? await db.prepare(
      `SELECT COUNT(*) AS count FROM trip_emergency_contacts
       WHERE trip_id = ? AND managed_by = 'human'`,
    ).bind(tripId).first<{ count: number }>()
    : await db.prepare(
      `SELECT COUNT(*) AS count FROM trip_pretrip_notes
       WHERE trip_id = ? AND managed_by = 'human'
         AND (origin = 'human' OR ai_source = ?)`,
    ).bind(tripId, PRETRIP_AI_SOURCES[active.doc_type]).first<{ count: number }>();
  const preservedManualCount = preservedManual?.count ?? manualRows.length;
  await db.prepare(
    `UPDATE trip_note_ai_jobs
     SET inserted_count = ?,
         replaced_count = ?,
         preserved_manual_count = ?,
         duplicate_excluded_count = ?,
         suppressed_count = ?
     WHERE id = ? AND generation = ? AND status = 'completed'`,
  ).bind(
    insertedCount,
    replacedCount,
    preservedManualCount,
    duplicateExcludedCount,
    suppressedCount,
    active.id,
    active.generation,
  ).run();

  const table = active.doc_type === 'emergency'
    ? 'trip_emergency_contacts'
    : 'trip_pretrip_notes';
  for (let index = 0; index < accepted.length; index++) {
    const insert = results[index + 1];
    if ((insert?.meta.changes ?? 0) === 0) continue;
    const recordId = Number(insert?.meta.last_row_id);
    if (!Number.isInteger(recordId) || recordId <= 0) continue;
    await logAudit(db, {
      tripId,
      tableName: table,
      recordId,
      action: 'insert',
      changedBy: actor,
      requestId,
      diffJson: JSON.stringify(accepted[index]),
    });
  }

  await rewriteRequestReply(
    db,
    requestId,
    `AI 生成完成 — 新增 ${insertedCount}、替換 ${replacedCount}、保留人工 ${preservedManualCount}、排除 ${duplicateExcludedCount}、略過 ${suppressedCount}。\n\n[前往行程筆記 →](/trip/${tripId}/notes)`,
  );
}
