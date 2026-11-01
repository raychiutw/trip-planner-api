/**
 * 舊 _middleware.ts 其餘全域功能的合併入口：api_logs 紀錄（最外層，連拒絕也記）→ companion 路徑白名單 → 非 JSON body 的 UTF-8／亂碼檢查。
 * ops scope gate 在各 admin handler 內以 requireScope 檢查（沒有全域 admin）。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { apiLogs } from './api-logs';
import { bodyEncodingViolation } from './body-encoding';
import { companionViolation } from './companion-scope';

export const legacyGates: MiddlewareHandler<AppEnv> = (c, next) =>
  apiLogs(c, async () => {
    const denied = companionViolation(c.req.raw) ?? (await bodyEncodingViolation(c.req.raw));
    if (denied) {
      c.res = denied;
      return;
    }
    await next();
  });
