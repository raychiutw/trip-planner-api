import { logAudit } from '../../lib/audit';
import { requireAuth, hasOpsScope, assertNotTripRestricted } from '../../lib/permissions';
import { AppError } from '../../errors';
import { generateUniqueTripId } from '../../lib/trip-write';
import { json, getAuth, parseJsonBody } from '../../lib/utils';
import type { Env } from '../../env';

// TRIPID_RE 已移除（2026-07-21）：ID 不再由呼叫端提供，格式由 src/lib/tripId 的
// genTripId 保證（有測試鎖 `^[a-z0-9][a-z0-9-]*$`），沒有外部輸入需要驗。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MAX_DAYS = 30;
const MAX_DESTINATIONS = 30;
const MS_PER_DAY = 86400000;

// 2026-05-02 follow-up: enum validation defense-in-depth — POST 端與 PUT 一致
// VALID_TRAVEL_MODES removed v2.31.36 (default_travel_mode column dropped — dead data).
const VALID_LANGS = new Set(['zh-TW', 'en', 'ja']);
const VALID_DATA_SOURCES = new Set(['manual', 'tp-create', 'imported']);


interface DestinationInput {
  name?: string;
  lat?: number;
  lng?: number;
  day_quota?: number;
  sub_areas?: string[];
}

function str(val: unknown, fallback = ''): string {
  if (typeof val === 'string') return val;
  if (val != null && typeof val === 'object') return JSON.stringify(val);
  return fallback;
}

// nullableStr removed v2.31.36 — only used by self_drive_* fields which were dropped.

function nullableNum(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  // v2.55.56: 受限 token 只做單一 trip 的內容編輯 — 不可建立新 trip。
  assertNotTripRestricted(auth);

  const body = await parseJsonBody<Record<string, unknown>>(context.request);

  // 2026-07-21（owner：「建立 id 規則要移往後端」「不要相容模式」）：
  // 行程 ID 一律由後端產生，呼叫端不得指定。
  //
  // 拒絕而非默默忽略：呼叫端若送了 id 又拿它去導頁，忽略的話會建立成功卻
  // 404 —— 「建立成功但看不到」比當場 400 難查太多。硬錯讓它立刻修。
  // 呼叫端一律改讀回應的 `tripId`。
  if (body.id !== undefined) {
    throw new AppError('DATA_VALIDATION', '行程 ID 由伺服器產生，請勿指定；請改用回應中的 tripId');
  }

  const name = body.name as string | undefined;
  const startDate = body.startDate as string | undefined;
  const endDate = body.endDate as string | undefined;

  if (!name || !startDate || !endDate) {
    throw new AppError('DATA_VALIDATION', '缺必填欄位：name, startDate, endDate');
  }
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new AppError('DATA_VALIDATION', '日期格式錯誤：須為 YYYY-MM-DD');
  }
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new AppError('DATA_VALIDATION', '日期無效');
  }
  if (end < start) {
    throw new AppError('DATA_VALIDATION', 'endDate 必須 ≥ startDate');
  }
  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (totalDays > MAX_DAYS) {
    throw new AppError('DATA_VALIDATION', `行程天數不可超過 ${MAX_DAYS} 天`);
  }

  // v2.31.36: default_travel_mode DROPPED — backend 沒讀此 column 改變行為，整套 schema/UI/code 拔。
  // 2026-05-02 follow-up: enum validation defense-in-depth
  if (body.lang !== undefined && !VALID_LANGS.has(body.lang as string)) {
    throw new AppError('DATA_VALIDATION', 'lang 必須為 zh-TW / en / ja 之一');
  }
  if (body.data_source !== undefined && !VALID_DATA_SOURCES.has(body.data_source as string)) {
    throw new AppError('DATA_VALIDATION', 'data_source 必須為 manual / tp-create / imported 之一');
  }

  // Validate optional destinations array (commit 7)
  // /review-fix: cap length 防 hostile payload 撐爆 D1 batch 100-stmt 上限。
  const destsRaw = body.destinations;
  let destinations: DestinationInput[] = [];
  if (Array.isArray(destsRaw)) {
    if (destsRaw.length > MAX_DESTINATIONS) {
      throw new AppError('DATA_VALIDATION', `destinations 數量不可超過 ${MAX_DESTINATIONS}`);
    }
    destinations = destsRaw.filter((d): d is DestinationInput =>
      d != null && typeof d === 'object' && typeof (d as DestinationInput).name === 'string',
    );
  }

  const db = context.env.DB;
  // ID 由後端產生並保證未被使用（撞號自動重生，不對呼叫端拋 DATA_CONFLICT ——
  // 呼叫端已無從選擇 id，怪它撞號沒有道理，也沒有自救方式）。
  const id = await generateUniqueTripId(db, name);

  const stmts: D1PreparedStatement[] = [];

  // Migration 0045: dropped self_drive/og_description/footer/food_prefs/auto_scroll/is_default.
  // Added data_source/lang.
  // Migration 0068 (v2.31.36): DROP default_travel_mode + 5 self_drive_* — dead columns（UI 收集但 backend 沒讀）。
  // V2 cutover phase 2: trips.owner email column dropped, NOT NULL owner_user_id only。
  if (!auth.userId) throw new AppError('AUTH_REQUIRED', '需 V2 OAuth 登入才能建立行程');
  stmts.push(
    db.prepare(
      'INSERT INTO trips (id, name, owner_user_id, title, description, countries, published, data_source, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      id, name, auth.userId,
      str(body.title),
      str(body.description),
      str(body.countries, 'JP'),
      body.published != null ? Number(body.published) : 0,
      str(body.data_source, 'manual'),
      str(body.lang, 'zh-TW'),
    ),
  );

  // trip_days
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getTime() + i * MS_PER_DAY);
    const date = d.toISOString().slice(0, 10);
    const dayOfWeek = WEEKDAYS[d.getUTCDay()];
    stmts.push(
      db.prepare(
        'INSERT INTO trip_days (trip_id, day_num, date, day_of_week, label) VALUES (?, ?, ?, ?, ?)',
      ).bind(id, i + 1, date, dayOfWeek, ''),
    );
  }

  // trip_permissions: owner row — V2 cutover phase 2: 純 user_id (email column dropped)
  stmts.push(
    db.prepare(
      'INSERT INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, ?)',
    ).bind(auth.userId, id, 'owner'),
  );

  // trip_destinations: write each dest with dest_order (commit 7)
  // v2.29.0: trip_destinations.{osm_id, osm_type} DROPPED.
  destinations.forEach((d, idx) => {
    stmts.push(
      db.prepare(
        `INSERT INTO trip_destinations (trip_id, dest_order, name, lat, lng, day_quota, sub_areas)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        idx + 1,
        d.name ?? '',
        nullableNum(d.lat),
        nullableNum(d.lng),
        nullableNum(d.day_quota),
        Array.isArray(d.sub_areas) ? JSON.stringify(d.sub_areas) : null,
      ),
    );
  });

  await db.batch(stmts);

  await logAudit(db, {
    tripId: id,
    tableName: 'trips',
    recordId: null,
    action: 'insert',
    changedBy: auth.email,
    diffJson: JSON.stringify(body),
  });

  return json({ ok: true, tripId: id, daysCreated: totalDays, destinationsCreated: destinations.length }, 201);
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const showAll = url.searchParams.get('all') === '1';
  const auth = getAuth(context);

  // `GET /api/trips` 是**未登入可讀**的公開行程清單，一律不回擁有者個資。
  //
  // 沿革：2026-07-16 前零認證就能拿到每個公開行程擁有者的 email；當時把門檻設成
  // 「已登入且未受 trip 限制」。2026-07-21 實測發現那個門檻等於沒有 —— 用當天新
  // 註冊的帳號打 prod，照樣撈到與該帳號毫無關係的第三方 email。註冊人人都能做。
  //
  // 直接拿掉而不是加權限判斷：這兩欄在本端點**沒有任何 consumer**。前端行程清單
  // 讀的是 `/api/my-trips`（TripsListPage.tsx:832），owner 由那支供應，且那支以
  // trip_permissions 為條件 —— 給的是「你有權限的行程」的 owner，本來就合理。
  // 少一個條件分支就少一種設錯的方式。
  // display_name 同屬個資（登入時預設帶 Google 真名，見 callback/google.ts），
  // 對齊 _share.ts:154「匿名分享連結 never expose the owner's name」。
  const baseCols = `t.id AS tripId, t.name,
                    t.owner_user_id,
                    t.title,
                    t.countries, t.published, t.data_source, t.lang,
                    (SELECT COUNT(*) FROM trip_days d WHERE d.trip_id = t.id) AS day_count,
                    (SELECT MIN(date) FROM trip_days d WHERE d.trip_id = t.id AND date IS NOT NULL) AS start_date,
                    (SELECT MAX(date) FROM trip_days d WHERE d.trip_id = t.id AND date IS NOT NULL) AS end_date,
                    (SELECT COUNT(DISTINCT user_id) FROM trip_permissions p WHERE p.trip_id = t.id) AS member_count`;

  const fromJoin = `FROM trips t LEFT JOIN users u ON u.id = t.owner_user_id`;
  // Phase 1（移除全域 admin）：跨-trip 全列表改 service-token ops:trips:read（daily-report 用）。
  const sql = showAll && hasOpsScope(auth, 'ops:trips:read')
    ? `SELECT ${baseCols} ${fromJoin} ORDER BY t.name ASC`
    : `SELECT ${baseCols} ${fromJoin} WHERE t.published = 1 ORDER BY t.name ASC`;

  const { results } = await context.env.DB.prepare(sql).all();
  return json(results);
};
