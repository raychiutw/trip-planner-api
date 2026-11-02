import type { AuthData } from '../env';

/**
 * 資料最小化（ADR-0012）：服務 token（agent、維運）讀請求時不需要送出者的 email，只留顯示名稱
 * （submitted_by_display_name）。一般使用者的回應完全不變。
 */
export function omitSubmitterEmail<T extends Record<string, unknown>>(auth: AuthData, row: T): T | Omit<T, 'submitted_by'> {
  if (!auth.isServiceToken) return row;
  const { submitted_by: _email, ...rest } = row;
  return rest;
}
