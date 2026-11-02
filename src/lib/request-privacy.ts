import type { AuthData } from '../env';

/**
 * 資料最小化（ADR-0012）：交給 AI 的路徑不需要送出者的 email，只留顯示名稱（submitted_by_display_name）。
 * 「AI 路徑」＝服務 token，以及 restrict_trip 範圍的使用者 token（agent 的 MCP 工具實際用的，isServiceToken 為 false）。
 * 一般使用者（沒有 restrictTrip）的回應完全不變。
 */
export function omitSubmitterEmail<T extends Record<string, unknown>>(auth: AuthData, row: T): T | Omit<T, 'submitted_by'> {
  if (!auth.isServiceToken && auth.restrictTrip === undefined) return row;
  const { submitted_by: _email, ...rest } = row;
  return rest;
}
