/**
 * Travel mode canonical type + labels + icons.
 *
 * v2.33.28: extracted to dedupe TravelPill / EditEntryPage local maps. Same
 * 3 modes used backend-side (functions/api/trips/[id]/days/_merge.ts) so labels
 * align with trip_segments.mode CHECK constraint.
 *
 * 注意：TravelPill 還處理 legacy raw `entry.travel.type` 值（car/drive/walk/
 * train/bus/...），那些保留在 TravelPill.tsx 自己的 alias map，不放這裡。
 */

export type TravelMode = 'driving' | 'walking' | 'transit';

/** 手填分鐘上限（對齊 backend segments/_shared.ts MAX_SEGMENT_MIN=1440）。 */
export const MAX_SEGMENT_MIN_CLIENT = 1440;

export const TRAVEL_MODE_LABEL: Record<TravelMode, string> = {
  driving: '開車',
  walking: '步行',
  transit: '大眾運輸',
};

export const TRAVEL_MODE_ICON: Record<TravelMode, string> = {
  driving: 'car',
  walking: 'walking',
  transit: 'bus',
};

/**
 * v2.55.45 交通方式細分（submode）。mode 維持 3 canonical（不碰 CHECK），transit 段
 * 用 submode 分具體方式。driving/walking submode 恆 null。
 *   - 自動算：monorail（沖繩單軌，本地 Yui 估）；bus / metro / train / hsr（v2.55.72 起
 *     一律預設用駕車 Google DRIVE 估車程距離）。無大眾運輸 API → 以開車為預設估值，
 *     使用者可手填分鐘覆寫鎖定。選了即存（不強制手填），修復「選火車按關閉沒作用」。
 *   - 其他：自由輸入方式名（submode = 使用者輸入的字，直接當 label；仍需先填方式名）。
 */
export interface TravelMethod {
  /** 穩定 key（chip testid 用）。 */
  key: string;
  mode: TravelMode;
  /** transit 細分；driving/walking/other = null（other 由自由輸入決定）。 */
  submode: string | null;
  label: string;
  iconName: string;
  /** true = 選了即自動算（driving/walking/monorail/bus/metro/train/hsr）；false = 純手填（僅「其他」）。 */
  auto: boolean;
  /** 「其他」：自由輸入方式名。 */
  freeText?: boolean;
}

export const TRAVEL_METHODS: readonly TravelMethod[] = [
  { key: 'driving', mode: 'driving', submode: null, label: '駕車', iconName: 'car', auto: true },
  { key: 'walking', mode: 'walking', submode: null, label: '步行', iconName: 'walking', auto: true },
  { key: 'monorail', mode: 'transit', submode: 'monorail', label: '單軌', iconName: 'train', auto: true },
  { key: 'bus', mode: 'transit', submode: 'bus', label: '公車', iconName: 'bus', auto: true },
  { key: 'metro', mode: 'transit', submode: 'metro', label: '地鐵', iconName: 'train', auto: true },
  { key: 'train', mode: 'transit', submode: 'train', label: '火車', iconName: 'train', auto: true },
  { key: 'hsr', mode: 'transit', submode: 'hsr', label: '高鐵', iconName: 'train', auto: true },
  { key: 'other', mode: 'transit', submode: null, label: '其他', iconName: 'route', auto: false, freeText: true },
];

/**
 * submode → TravelMethod（僅固定 submode 的 transit 方式：monorail/bus/metro/train/hsr；
 * 'other' 是自由文字、submode 由使用者決定故不在此表）。單一 SoT：全部從 TRAVEL_METHODS
 * 衍生，避免另立手維護的 label/icon 平行表（新增方式只改 TRAVEL_METHODS 一處）。
 */
const SUBMODE_METHOD: ReadonlyMap<string, TravelMethod> = new Map(
  TRAVEL_METHODS.filter((m) => m.mode === 'transit' && m.submode).map((m) => [m.submode as string, m]),
);

/** 某段的方式 label：transit 看 submode（未知＝自由文字 passthrough），否則看 mode。 */
export function travelMethodLabel(mode: string, submode: string | null | undefined): string {
  if (mode === 'transit' && submode) return SUBMODE_METHOD.get(submode)?.label ?? submode;
  return TRAVEL_MODE_LABEL[mode as TravelMode] ?? '';
}
/** 某段的 icon name：transit 看 submode（未知＝bus fallback），否則看 mode。 */
export function travelMethodIcon(mode: string, submode: string | null | undefined): string {
  if (mode === 'transit' && submode) return SUBMODE_METHOD.get(submode)?.iconName ?? 'bus';
  return TRAVEL_MODE_ICON[mode as TravelMode] ?? 'car';
}
/** 依 (mode, submode) 找 picker chip key（未知 submode ＝ 其他）。 */
export function travelMethodKey(mode: string, submode: string | null | undefined): string {
  if (mode === 'driving') return 'driving';
  if (mode === 'walking') return 'walking';
  if (submode && SUBMODE_METHOD.has(submode)) return submode;
  return 'other';
}
