/**
 * yuiRail.ts — 沖繩單軌（ゆいレール / 沖縄都市モノレール線）靜態站表 + 車程估算。
 *
 * 用途：交通方式「單軌」的自動計算 —— walk(A→最近站) + 單軌(站→站) + walk(站→B)。
 * 純資料 + 純函式（無 DB / 無 env / 無 API），backend segments/_shared.ts 與
 * recompute-travel.ts 共用同一核心 computeYuiTravel()。
 *
 * ## 資料來源（擷取 2026-07）
 *   - 站名 + 座標：HeartRails Express API（method=getStations&line=沖縄ゆいレール）。
 *   - 累計營業キロ（cumKm，距那覇空港）：日文 Wikipedia「沖縄都市モノレール線」駅一覧。
 *   - 站間分鐘：由 cumKm 依官方端到端 37 分（那覇空港 ↔ てだこ浦西）等比推導
 *     （railMinutes）。單線、無分歧，等比誤差 ≈ ±1 分（例：県庁前 官方 ~12、本表 13；
 *     首里 官方 ~27、本表 28），對行程規劃足夠。日後要精準可換 GTFS stop_times。
 *
 * 單軌只有一條線、19 站、無轉乘 → 站到站時間/距離 = 兩站 cumKm 之差（方向無關）。
 */
import { haversineMeters } from './geo';

export interface YuiStation {
  /** 站名（日文，對齊 HeartRails / Wikipedia） */
  name: string;
  lat: number;
  lng: number;
  /** 距那覇空港的累計營業キロ（km，實際里程非直線） */
  cumKm: number;
}

/** 那覇空港（0.0）→ てだこ浦西（17.0），順序即上/下行沿線順序。 */
export const YUI_STATIONS: readonly YuiStation[] = [
  { name: '那覇空港', lat: 26.206515, lng: 127.652214, cumKm: 0.0 },
  { name: '赤嶺', lat: 26.193289, lng: 127.660348, cumKm: 2.0 },
  { name: '小禄', lat: 26.196455, lng: 127.666853, cumKm: 2.8 },
  { name: '奥武山公園', lat: 26.200714, lng: 127.675252, cumKm: 3.8 },
  { name: '壺川', lat: 26.205927, lng: 127.678344, cumKm: 4.6 },
  { name: '旭橋', lat: 26.211910, lng: 127.675515, cumKm: 5.4 },
  { name: '県庁前', lat: 26.214446, lng: 127.679343, cumKm: 6.0 },
  { name: '美栄橋', lat: 26.219245, lng: 127.684328, cumKm: 6.7 },
  { name: '牧志', lat: 26.217248, lng: 127.692550, cumKm: 7.7 },
  { name: '安里', lat: 26.216737, lng: 127.695736, cumKm: 8.3 },
  { name: 'おもろまち', lat: 26.222701, lng: 127.698391, cumKm: 9.0 },
  { name: '古島', lat: 26.230919, lng: 127.703079, cumKm: 10.0 },
  { name: '市立病院前', lat: 26.227548, lng: 127.710003, cumKm: 10.9 },
  { name: '儀保', lat: 26.224663, lng: 127.719039, cumKm: 11.9 },
  { name: '首里', lat: 26.219191, lng: 127.725492, cumKm: 12.9 },
  { name: '石嶺', lat: 26.227000, lng: 127.729006, cumKm: 13.8 },
  { name: '経塚', lat: 26.236722, lng: 127.728515, cumKm: 15.0 },
  { name: '浦添前田', lat: 26.243862, lng: 127.732298, cumKm: 16.0 },
  { name: 'てだこ浦西', lat: 26.241759, lng: 127.741959, cumKm: 17.0 },
];

const YUI_TOTAL_KM = 17.0;
const YUI_TOTAL_MIN = 37; // 那覇空港 ↔ てだこ浦西 官方端到端所要時分

/** POI 離最近站超過此距離 → 不視為「可搭單軌」（該退回其他方式）。 */
export const YUI_ACCESS_MAX_M = 1200;
/** 徒步估：直線距離換算分鐘（含路徑迂迴，約 4 km/h 有效速度）。 */
const WALK_MIN_PER_KM = 14;

/** 找離某座標最近的 Yui 站 + 直線距離（公尺）。表非空故必回站。 */
export function nearestYuiStation(pt: { lat: number; lng: number }): { station: YuiStation; distanceM: number } {
  let best: YuiStation = YUI_STATIONS[0]!; // 表為硬編 19 站非空常數
  let bestD = Infinity;
  for (const st of YUI_STATIONS) {
    const d = haversineMeters(pt, { lat: st.lat, lng: st.lng });
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return { station: best, distanceM: bestD };
}

/** 兩站間單軌分鐘（等比 cumKm，最少 1 分；同站 → 0）。 */
export function railMinutes(a: YuiStation, b: YuiStation): number {
  const deltaKm = Math.abs(a.cumKm - b.cumKm);
  if (deltaKm === 0) return 0;
  return Math.max(1, Math.round((deltaKm / YUI_TOTAL_KM) * YUI_TOTAL_MIN));
}

/** 兩站間單軌距離（公尺，實際里程）。 */
export function railMeters(a: YuiStation, b: YuiStation): number {
  return Math.round(Math.abs(a.cumKm - b.cumKm) * 1000);
}

function walkMinutes(distanceM: number): number {
  return Math.max(1, Math.round((distanceM / 1000) * WALK_MIN_PER_KM));
}

export type YuiTravelResult =
  | { ok: true; min: number; distanceM: number }
  | { ok: false; reason: 'too_far' | 'same_station' };

/**
 * 純函式核心：算 from→to 的「單軌+步行」總分鐘與總距離。
 *   walk(A→最近站) + 單軌(站→站) + walk(站→B)。
 * 兩端任一離最近站 > YUI_ACCESS_MAX_M → too_far（該段不適用單軌）。
 * 兩端最近站相同 → same_station（純走路即可，不必搭）。
 * 走路段用直線估（不打 Google API）→ recompute 也能免費呼叫。
 */
export function computeYuiTravel(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): YuiTravelResult {
  const a = nearestYuiStation(from);
  const b = nearestYuiStation(to);
  if (a.distanceM > YUI_ACCESS_MAX_M || b.distanceM > YUI_ACCESS_MAX_M) {
    return { ok: false, reason: 'too_far' };
  }
  if (a.station === b.station) {
    return { ok: false, reason: 'same_station' };
  }
  const min = walkMinutes(a.distanceM) + railMinutes(a.station, b.station) + walkMinutes(b.distanceM);
  const distanceM = Math.round(a.distanceM + railMeters(a.station, b.station) + b.distanceM);
  return { ok: true, min, distanceM };
}
