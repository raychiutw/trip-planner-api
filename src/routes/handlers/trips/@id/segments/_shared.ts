/**
 * segments/_shared.ts — segment travel 計算共用邏輯（PATCH /:sid 與 POST 共用）。
 *
 * 抽出「依 mode / submode 算 min / distance / source」的邏輯，讓「改既有 segment」
 * （PATCH /:sid）與「建立 segment」（POST）兩條路徑共用，避免 Google Routes 呼叫重複。
 *
 * ## 方式（submode）與計算策略（v2.55.45）
 *
 *   mode='driving' / 'walking' → Google Routes 自動算（DRIVE / WALK）。submode 恆 null。
 *   mode='transit' + submode：
 *     - 'monorail'（沖繩單軌）→ 自動算 walk+單軌+walk（yuiRail.computeYuiTravel，
 *       走路段直線估、不打 API）。source='haversine'。
 *     - 其餘（bus / metro / train / hsr / 自由文字 / null）→ v2.55.72 起一律自動、預設用駕車
 *       Google DRIVE 估車程與距離（無大眾運輸 API，開車為預設估值）。source='google'。
 *       不再強制手填 min（「選了即存」），可手填分鐘覆寫鎖定。
 *
 * ## 覆寫 / 恢復自動（source 當鎖定旗標）
 *
 *   自動算的方式（driving/walking/monorail/bus/metro/train/hsr）若 caller 帶了有效 manualMin →
 *   視為「使用者手動覆寫」→ 鎖定該值、source='manual'、距離改直線。之後 recompute
 *   會依 source='manual' 跳過不覆寫（見 recompute-travel.ts）。「恢復自動計算」= 前端
 *   重送不帶 min → 走自動路徑、source 回 google/haversine。
 *
 * 硬錯誤（min_required / 單軌 too_far / same_station）throw DATA_VALIDATION → 400；
 * 軟失敗（缺 coords / API error / quota lock）回 ok:false → caller 保留舊值標 stale。
 */
import { computeRoute } from '../../../../../lib/maps/google-client';
import { computeYuiTravel } from '../../../../../lib/yuiRail';
import { haversineMeters } from '../../../../../lib/geo';
import { assertGoogleAvailable } from '../../../../../lib/maps-lock';
import { AppError } from '../../../../../errors';
import type { Env } from '../../../../../env';

export const VALID_SEGMENT_MODES = ['driving', 'walking', 'transit'] as const;
export type SegmentMode = (typeof VALID_SEGMENT_MODES)[number];
export const MAX_SEGMENT_MIN = 1440;
/** submode 最長字數（自由輸入方式名會被當 label 顯示 → 限長 + 去控制字元）。 */
export const MAX_SUBMODE_LEN = 20;
/** PATCH/POST 回傳的 segment row 欄位（固定常數、非 user input）。加欄時只改這一處。 */
export const SEGMENT_RETURNING_COLS =
  'id, trip_id, from_entry_id, to_entry_id, mode, submode, min, distance_m, source, computed_at, updated_at, version, no_travel';

export function isSegmentMode(v: unknown): v is SegmentMode {
  return typeof v === 'string' && (VALID_SEGMENT_MODES as readonly string[]).includes(v);
}

/**
 * 淨化 submode（自由輸入方式名會當 label 顯示給協作者）：去危險字元 + trim + 限長；
 * 空 → null。非 transit 一律 null。用 char-code 過濾而非 regex escape，避免 source 中
 * 不可見字元被工具吞掉。剝除（保留 CJK / 一般文字）：
 *   C0(0x00–0x1F)/DEL、C1(0x80–0x9F)、零寬(ZWSP/ZWJ/BOM…)、雙向 override/isolate、行分隔。
 * 匯入路徑另有自含的 cleanSubmode（functions/api/trips/_import.ts）須同步維護。
 */
export function sanitizeSubmode(raw: unknown, mode: SegmentMode): string | null {
  if (mode !== 'transit' || typeof raw !== 'string') return null;
  let cleaned = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue;               // C0 控制字元 + DEL
    if (c >= 0x80 && c <= 0x9f) continue;               // C1 控制字元
    if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfeff || c === 0x2060) continue; // 零寬
    if (c >= 0x202a && c <= 0x202e) continue;           // bidi embedding/override
    if (c >= 0x2066 && c <= 0x2069) continue;           // bidi isolates
    if (c === 0x200e || c === 0x200f || c === 0x061c) continue; // 方向標記 LRM/RLM/ALM
    if (c === 0x2028 || c === 0x2029) continue;         // line/para separator
    cleaned += ch;
  }
  // 依 code point 切（非 UTF-16 code unit）避免星平面字元被切成孤立 surrogate。
  const s = [...cleaned.trim()].slice(0, MAX_SUBMODE_LEN).join('');
  return s.length > 0 ? s : null;
}

export function isValidMin(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_SEGMENT_MIN;
}

export type SegmentTravelResult =
  | { ok: true; min: number; distanceM: number | null; source: 'google' | 'manual' | 'haversine'; submode: string | null; computedAt: number }
  | { ok: false };

/** 取某 entry 的 master POI（sort_order=1）座標；缺 POI 或缺座標 → null。 */
async function entryMasterCoords(
  db: D1Database,
  entryId: number,
): Promise<{ lat: number; lng: number } | null> {
  const row = await db
    .prepare(
      `SELECT p.lat AS lat, p.lng AS lng
       FROM trip_entry_pois tep
       JOIN pois p ON p.id = tep.poi_id
       WHERE tep.entry_id = ? AND tep.sort_order = 1`,
    )
    .bind(entryId)
    .first<{ lat: number | null; lng: number | null }>();
  if (!row || row.lat == null || row.lng == null) return null;
  return { lat: row.lat, lng: row.lng };
}

/** 兩 entry master 座標的直線距離（公尺）；任一缺座標 → null。 */
async function haversineFromEntries(
  db: D1Database,
  fromEntryId: number,
  toEntryId: number,
): Promise<number | null> {
  const [from, to] = await Promise.all([
    entryMasterCoords(db, fromEntryId),
    entryMasterCoords(db, toEntryId),
  ]);
  if (!from || !to) return null;
  return Math.round(haversineMeters(from, to));
}

/**
 * 算 from→to 的 travel fields（不寫 DB）。
 *
 * @param submode transit 的細分方式（monorail/bus/metro/train/hsr/自由文字）；已淨化。
 * @param manualMin 使用者手填分鐘；出現在自動方式上 = 覆寫鎖定。
 */
export async function resolveSegmentTravel(
  env: Env,
  db: D1Database,
  fromEntryId: number,
  toEntryId: number,
  mode: SegmentMode,
  submode: string | null,
  manualMin: number | undefined,
  now: number,
): Promise<SegmentTravelResult> {
  const hasManual = isValidMin(manualMin);

  // --- driving / walking ---
  if (mode !== 'transit') {
    if (hasManual) {
      // 手填覆寫駕車/步行 → 鎖定，距離改直線估。
      const distanceM = await haversineFromEntries(db, fromEntryId, toEntryId);
      return { ok: true, min: Math.round(manualMin as number), distanceM, source: 'manual', submode: null, computedAt: now };
    }
    return computeGoogle(env, db, fromEntryId, toEntryId, mode === 'walking' ? 'WALK' : 'DRIVE', null, now);
  }

  // --- transit family ---
  // 自動方式（未被手填覆寫）：
  //   monorail → 沖繩單軌本地 Yui 估（0 API）。
  //   其餘（bus / metro / train / hsr / 自由文字 / null）→ v2.55.72 起一律預設用駕車 Google
  //     DRIVE 估車程與距離（無大眾運輸 API，開車為預設估值，submode 原樣保留當 label）。
  //     不再強制手填 min → 前端「選了即存」，消除選火車/地鐵按關閉的無聲丟失。
  if (!hasManual && submode === 'monorail') {
    return computeMonorail(db, fromEntryId, toEntryId, now);
  }
  if (!hasManual) {
    return computeGoogle(env, db, fromEntryId, toEntryId, 'DRIVE', submode, now);
  }
  // 手填覆寫：鎖定手填值（source='manual'），距離自動算直線。
  const distanceM = await haversineFromEntries(db, fromEntryId, toEntryId);
  return { ok: true, min: Math.round(manualMin as number), distanceM, source: 'manual', submode, computedAt: now };
}

/** driving / walking / bus 共用：Google Routes 重算。缺 coords / API 失敗 → ok:false（保留舊值）。 */
async function computeGoogle(
  env: Env,
  db: D1Database,
  fromEntryId: number,
  toEntryId: number,
  apiMode: 'WALK' | 'DRIVE',
  submode: string | null,
  now: number,
): Promise<SegmentTravelResult> {
  const [from, to] = await Promise.all([
    entryMasterCoords(db, fromEntryId),
    entryMasterCoords(db, toEntryId),
  ]);
  if (!from || !to || !env.GOOGLE_MAPS_API_KEY) return { ok: false };
  try {
    // MAPS_LOCKED kill-switch parity（對齊 recompute-travel）。
    await assertGoogleAvailable(db);
    const result = await computeRoute(env.GOOGLE_MAPS_API_KEY, from, to, apiMode);
    return {
      ok: true,
      min: Math.round(result.duration_seconds / 60),
      distanceM: result.distance_meters,
      source: 'google',
      submode,
      computedAt: now,
    };
  } catch {
    return { ok: false };
  }
}

/** 沖繩單軌自動算：walk+單軌+walk（直線估，不打 API）。兩端離站太遠 / 同站 → 硬錯誤 400。 */
async function computeMonorail(
  db: D1Database,
  fromEntryId: number,
  toEntryId: number,
  now: number,
): Promise<SegmentTravelResult> {
  const [from, to] = await Promise.all([
    entryMasterCoords(db, fromEntryId),
    entryMasterCoords(db, toEntryId),
  ]);
  if (!from || !to) return { ok: false }; // 缺座標 → 軟失敗保留舊值（同 driving/walking）
  const yui = computeYuiTravel(from, to);
  if (!yui.ok) {
    throw new AppError(
      'DATA_VALIDATION',
      yui.reason === 'same_station' ? '兩地最近站相同，建議用步行' : '此段離單軌站太遠，不適用單軌',
    );
  }
  return { ok: true, min: yui.min, distanceM: yui.distanceM, source: 'haversine', submode: 'monorail', computedAt: now };
}
