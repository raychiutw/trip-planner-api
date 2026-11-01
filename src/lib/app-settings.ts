/**
 * _app_settings.ts — typed accessor for `app_settings` D1 table.
 *
 * v2.33.62 round 14c: 之前散落 callsite 各自 parse `app_settings.value` (TEXT col)
 * 用文字 compare 判 boolean / int。每 callsite reimplement = future drift bug。
 *
 * 本檔集中: schema definition + typed read/write helper。所有 key 標型，
 * read 失敗 throw with clear error。
 *
 * 不改 D1 schema (避免 migration risk for LOW finding)。
 */
import type { D1Database } from '@cloudflare/workers-types';

export type AppSettingType = 'boolean' | 'integer' | 'string' | 'json';

/**
 * Schema: 已知 app_settings key → 預期型別。Adding new key 必須先在這註冊。
 * 未註冊的 key 走 raw string fallback (caller 自己解析)，但失去本檔 type safety。
 */
export const APP_SETTINGS_SCHEMA: Record<string, AppSettingType> = {
  google_maps_locked: 'boolean',
  google_maps_locked_reason: 'string',
  // hysteresis thresholds (migration 0051)
  // POI lifecycle backfill state
  pois_backfill_resume_id: 'integer',
};

/** Parse a TEXT value into expected type. Throws on type mismatch. */
export function parseAppSetting<T = unknown>(key: string, raw: string | null | undefined): T | null {
  if (raw == null) return null;
  const type = APP_SETTINGS_SCHEMA[key];
  if (!type) return raw as unknown as T; // unknown key — fallback raw string
  switch (type) {
    case 'boolean':
      return (raw === 'true' || raw === '1') as unknown as T;
    case 'integer': {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        // 純 utility throw plain Error — caller (admin endpoint) catch 後決定
        // HTTP shape；helper 不該 hardcode AppError code（layering 違反）。
        throw new Error(`app_settings.${key} parse failed: expected integer, got "${raw}"`);
      }
      return n as unknown as T;
    }
    case 'json':
      try {
        return JSON.parse(raw) as T;
      } catch {
        // 純 utility throw plain Error — 同上 layering 考量。
        throw new Error(`app_settings.${key} parse failed: invalid JSON`);
      }
    case 'string':
    default:
      return raw as unknown as T;
  }
}

/** Serialise typed value → TEXT for storage. */
export function serialiseAppSetting(key: string, value: unknown): string {
  const type = APP_SETTINGS_SCHEMA[key];
  if (!type) return String(value);
  switch (type) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'integer':
      return String(Math.trunc(Number(value)));
    case 'json':
      return JSON.stringify(value);
    case 'string':
    default:
      return String(value);
  }
}

/** Typed get helper — returns parsed value or null. Single-key SELECT. */
export async function getAppSetting<T = unknown>(
  db: D1Database,
  key: string,
): Promise<T | null> {
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return parseAppSetting<T>(key, row?.value);
}
