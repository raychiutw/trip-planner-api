/**
 * normalizePoiAddress — clean Google Places `formattedAddress` 常見 typo / artifact。
 *
 * v2.31.36 fix #137：Google Places 偶有 user-submitted 重複 admin suffix（user 提交
 * 時 typo），prod-found case「736 號號地下一層」doubled「號」。
 *
 * Strategy：
 * 1. Collapse 連續 admin suffix char（號/縣/市/区/區/県/町/路/街/巷/弄/鎮/鄉/村/里/号/丁）
 * 2. Collapse 連續逗號（含全形「，」）
 * 3. Collapse 連續空白為單一空白
 * 4. Trim 頭尾空白
 *
 * Apply：backend writes pois.address 邊界（google-client.ts search/details 邊界）+
 * backfill script 清 existing rows。Display-time consumers 不需改（reads clean data）。
 *
 * **不會 collapse 一般中文字（如「水水合甲烷」化學詞）— 只針對 admin/positional suffix
 * 白名單。**
 *
 * v2.55.x: 額外對台灣地址做簡轉繁（Google Places 對部分台灣 POI 的 address 回簡體，
 * 如「屏东县琉球乡」，languageCode/regionCode 皆無效）。只對含「台灣/臺灣」的地址套用，
 * 保護日本地址的簡日共用字形。見 `zh-tw-address.ts`。
 */

import { toTraditionalTwAddress } from './zh-tw-address';

// 連續會被視為 typo 的 admin / positional suffix char。
// 中文：號 縣 市 區 鎮 鄉 村 里 路 街 巷 弄
// 日文 kanji：号 県 区 町 丁
const ADMIN_SUFFIX_CHARS = '號号縣県市區区鎮鄉村里路街巷弄町丁';

const DOUBLED_ADMIN_RE = new RegExp(`([${ADMIN_SUFFIX_CHARS}])\\1+`, 'g');
const MULTI_WHITESPACE_RE = /\s{2,}/g;
const COMMA_SPACE_COMMA_RE = /[,，]\s*[,，]/g;

export function normalizePoiAddress(raw: string | null | undefined): string | null {
  if (raw == null || typeof raw !== 'string') return null;

  // 0. 台灣地址簡轉繁（Google Places locale fix；非台灣地址原樣保留）
  let s = toTraditionalTwAddress(raw);

  // 1. doubled admin suffix → single
  s = s.replace(DOUBLED_ADMIN_RE, '$1');

  // 2. doubled comma (含 separator + 全形) → single
  // 「,,」/「,, ,」/「，，」 各種組合都收斂為單個
  while (COMMA_SPACE_COMMA_RE.test(s)) {
    s = s.replace(COMMA_SPACE_COMMA_RE, (m) => (m.includes('，') ? '，' : ','));
  }

  // 3. multi-whitespace → single space
  s = s.replace(MULTI_WHITESPACE_RE, ' ');

  // 4. trim
  s = s.trim();

  return s.length > 0 ? s : null;
}
