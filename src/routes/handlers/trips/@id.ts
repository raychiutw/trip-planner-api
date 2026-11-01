import { logAudit, computeDiff } from '../../../lib/audit';
import { assertNotTripRestricted, hasWritePermission, requireAuth, requireTripReadAccess } from '../../../lib/permissions';
import { AppError } from '../../../errors';
import { json, parseJsonBody, buildUpdateClause, getAuth } from '../../../lib/utils';
import type { Env } from '../../../env';

// Migration 0045: dropped og_description/self_drive/food_prefs/auto_scroll/footer/is_default.
// Added data_source/lang (Q1, Q2). `region` derived from trip_destinations join — not a writable column.
// V2 cutover phase 2 (migration 0047): trips.owner column dropped — owner 改變需走
// transfer-ownership flow（未實作，phase 3）。
// Migration 0068 (v2.31.36): DROP default_travel_mode + 5 self_drive_* — dead columns。
const ALLOWED_FIELDS = [
  'name', 'title', 'description',
  'countries', 'published',
  'data_source', 'lang',
] as const;

interface TripDestRow {
  dest_order: number;
  name: string;
  lat: number | null;
  lng: number | null;
  day_quota: number | null;
  sub_areas: string | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { id } = context.params as { id: string };
  const db = context.env.DB;

  // v2.33.41 security: gate read access — published trips allow anonymous;
  // 否則必須 owner / member。
  await requireTripReadAccess(db, getAuth(context), id);

  const row = await db.prepare('SELECT *, id AS tripId FROM trips WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw new AppError('DATA_NOT_FOUND');

  // Commit 8: include trip_destinations array in single-trip GET response.
  // sub_areas stored as JSON array string — parse for client convenience.
  const dests = await db
    .prepare(
      'SELECT dest_order, name, lat, lng, day_quota, sub_areas FROM trip_destinations WHERE trip_id = ? ORDER BY dest_order ASC',
    )
    .bind(id)
    .all<TripDestRow>();

  row.destinations = dests.results.map((d) => ({
    ...d,
    sub_areas: d.sub_areas ? safeParseJson(d.sub_areas) : null,
  }));

  return json(row);
};

function safeParseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * DELETE /api/trips/:id — 刪除整個行程。
 *
 * V2-P7 PR-Q：trips 列表卡片 ... 菜單的「刪除」入口。權限：僅 trip owner
 *（Phase 3 移除全域 admin；co-editor 雖能編輯，destructive 操作仍限 owner）。
 *
 * Cascade：trip_days / trip_entries / pois (via trip_pois) / trip_pois /
 * poi_relations / trip_permissions / ideas /
 * trip_requests 都有 FK ON DELETE CASCADE references trips(id)，自動清。
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  // v2.55.56: 受限 token 不可刪任何 trip（含自己那個）— destructive，超出內容編輯 agent 的職權。
  assertNotTripRestricted(auth);

  const { id } = context.params as { id: string };
  const db = context.env.DB;

  const existing = await db
    .prepare('SELECT * FROM trips WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!existing) throw new AppError('DATA_NOT_FOUND');

  // Strict ownership check：只 owner 可刪（Phase 3：移除全域 admin）。Co-editor
  // (trip_permissions 列表上的) 雖然能編輯，但 destructive 操作必須 limit 到 owner。
  // V2 cutover phase 2: 純 owner_user_id check (owner email column dropped)
  const ownerUid = typeof existing.owner_user_id === 'string' ? existing.owner_user_id : null;
  if (!auth.userId || ownerUid !== auth.userId) {
    throw new AppError('PERM_DENIED', '僅行程擁有者可刪除');
  }

  await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();

  await logAudit(db, {
    tripId: id,
    tableName: 'trips',
    recordId: null,
    action: 'delete',
    changedBy: auth.email,
    snapshot: JSON.stringify(existing),
  });

  return json({ ok: true });
};

interface DestinationInput {
  name: string;
  lat?: number | null;
  lng?: number | null;
  day_quota?: number | null;
  sub_areas?: string[] | null;
}

const MAX_DESTINATIONS = 30;

// 2026-05-02 follow-up: enum validation defense-in-depth — PUT body 來自 CLI/外部 client。
// v2.31.36: VALID_TRAVEL_MODES removed — default_travel_mode column dropped (migration 0068)。
const VALID_LANGS = new Set(['zh-TW', 'en', 'ja']);
const VALID_DATA_SOURCES = new Set(['manual', 'tp-create', 'imported']);

function isValidDestination(d: unknown): d is DestinationInput {
  if (!d || typeof d !== 'object') return false;
  const obj = d as Record<string, unknown>;
  return typeof obj.name === 'string' && obj.name.trim().length > 0;
}

/** /review-fix: sub_areas runtime 必須是 string array，避免被 nested object 撐爆 row */
function safeSubAreas(val: unknown): string | null {
  if (!Array.isArray(val)) return null;
  if (!val.every((s) => typeof s === 'string')) return null;
  return JSON.stringify(val);
}

/** Validate enum body fields. Throws AppError on bad value. Allows undefined (field not being updated). */
function validateEnumFields(body: Record<string, unknown>): void {
  // v2.31.36: default_travel_mode validation removed — column dropped (migration 0068)。
  if (body.lang !== undefined && !VALID_LANGS.has(body.lang as string)) {
    throw new AppError('DATA_VALIDATION', `lang 必須為 zh-TW / en / ja 之一`);
  }
  if (body.data_source !== undefined && !VALID_DATA_SOURCES.has(body.data_source as string)) {
    throw new AppError('DATA_VALIDATION', `data_source 必須為 manual / tp-create / imported 之一`);
  }
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const { id } = context.params as { id: string };

  const db = context.env.DB;
  const [hasPerm, existing] = await Promise.all([
    hasWritePermission(db, auth, id),
    db.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first() as Promise<Record<string, unknown> | null>,
  ]);
  if (!hasPerm) throw new AppError('PERM_DENIED');
  if (!existing) throw new AppError('DATA_NOT_FOUND');

  const body = await parseJsonBody<Record<string, unknown>>(context.request);

  // 2026-05-02 follow-up: enum validation 防 hostile / typo payload 寫進 prod。
  validateEnumFields(body);

  // OSM PR (migration 0045)：destinations[] 為非 trips 欄位的特殊 nested resource，
  // 用 full-replacement 語意 — 給定 array 即 DELETE existing + INSERT all。
  // 無 destinations key → 不動 trip_destinations。空 array → 清光（user 想清空）。
  // /review-fix: 集中 stmts → 單次 db.batch() 確保 atomic（DELETE+INSERT 不分裂）。
  // /review-fix: cap length 防 hostile payload 撐爆 D1 batch 100-stmt 上限。
  const hasDestinations = Array.isArray(body.destinations);
  if (hasDestinations && (body.destinations as unknown[]).length > MAX_DESTINATIONS) {
    throw new AppError('DATA_VALIDATION', `destinations 數量不可超過 ${MAX_DESTINATIONS}`);
  }
  const update = buildUpdateClause(body, ALLOWED_FIELDS);
  if (!update && !hasDestinations) throw new AppError('DATA_VALIDATION', '無有效欄位可更新');

  const changedBy = auth.email;
  const stmts: D1PreparedStatement[] = [];

  if (update) {
    stmts.push(db.prepare(`UPDATE trips SET ${update.setClauses} WHERE id = ?`).bind(...update.values, id));
  }

  if (hasDestinations) {
    const inputs = (body.destinations as unknown[]).filter(isValidDestination);
    stmts.push(db.prepare('DELETE FROM trip_destinations WHERE trip_id = ?').bind(id));
    inputs.forEach((d, idx) => {
      stmts.push(
        db.prepare(
          `INSERT INTO trip_destinations
            (trip_id, dest_order, name, lat, lng, day_quota, sub_areas)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          idx,
          d.name,
          d.lat ?? null,
          d.lng ?? null,
          d.day_quota ?? null,
          safeSubAreas(d.sub_areas),
        ),
      );
    });
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  const newFields: Record<string, unknown> = update
    ? Object.fromEntries(update.fields.map(f => [f, body[f]]))
    : {};
  if (hasDestinations) {
    newFields.destinations_count = (body.destinations as unknown[]).length;
  }

  await logAudit(db, {
    tripId: id,
    tableName: 'trips',
    recordId: null,
    action: 'update',
    changedBy,
    diffJson: computeDiff(existing, newFields),
  });

  return json({ ok: true });
};
