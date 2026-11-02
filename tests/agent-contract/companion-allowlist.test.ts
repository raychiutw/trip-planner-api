/**
 * agent MCP server 的 companion 工具 ↔ api 的 companion 閘門（src/middleware/companion-scope.ts）。
 *
 * 正向：快照裡每個 companion 工具（method + path 模板）都必須 (1) 在白名單內、(2) 真的過得了閘門並對應到存在的路由。
 * 反向：api 白名單中「agent 沒有對應 companion 工具」的項目，必須逐一列在 API_ONLY 裡——
 *       擴權（白名單多一項）會讓這個測試紅，逼你有意識地同時改 fixture／本清單。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/app';
import { COMPANION_ALLOWED } from '../../src/middleware/companion-scope';
import type { Env } from '../../src/env';
import { createD1 } from '../support/d1';
import { contract } from './helpers';

const app = createApp();
let d1: ReturnType<typeof createD1>;
let env: Env;
beforeAll(() => { d1 = createD1(); env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env; });
afterAll(() => d1.close());

const SCOPE_DETAIL = '此操作超出旅伴請求範圍';
/** 模板 → 具體路徑：{tripId} 用 trip id，其餘佔位符用數字 id。 */
const concrete = (tpl: string) => tpl.replace('{tripId}', 'trip-abc').replace(/\{[^}]+\}/g, '7');
const key = (e: { method: string; pattern: RegExp }) => `${e.method} ${e.pattern.source}`;

describe('快照中的 companion 工具', () => {
  it('快照不是空的', () => {
    expect(contract.companionTools.length).toBeGreaterThanOrEqual(10);
  });

  for (const tool of contract.companionTools) {
    const path = concrete(tool.path);

    it(`${tool.name}（${tool.method} ${tool.path}）在 COMPANION_ALLOWED 內`, () => {
      expect(COMPANION_ALLOWED.some((a) => a.method === tool.method && a.pattern.test(path))).toBe(true);
    });

    it(`${tool.name} 實際送出 companion 請求：過得了閘門，且對應到存在的路由（走到認證才被擋）`, async () => {
      const res = await app.request(`https://test.com${path}`, {
        method: tool.method,
        headers: { 'X-Request-Scope': 'companion' },   // 與 MCP server 一樣不帶 Origin
      }, env);
      const body = (await res.json().catch(() => ({}))) as { error?: { detail?: string } };
      expect(body.error?.detail, '被 companion 閘門擋下').not.toBe(SCOPE_DETAIL);
      // 非 GET 沒帶認證：過了閘門與 CSRF 應停在 401；404／405 代表路徑沒有對應的路由
      if (tool.method !== 'GET') expect(res.status, '路由不存在或方法不符').toBe(401);
    });
  }
});

describe('api 白名單 ⊆ agent 工具（反向守衛）', () => {
  /** 目前 api 比 agent 多放行的項目。新增白名單項目要同時改這裡——這是刻意的摩擦。 */
  const API_ONLY = [
    // 讀取：agent 的讀取工具（getTrip／getDay／listRequests／poiSearch）不帶 companion header
    'GET ^\\/api\\/trips\\/',
    'GET ^\\/api\\/requests',
    'GET ^\\/api\\/poi-favorites$',
    // 請求生命週期：updateRequest 不帶 companion header（走自己的授權）
    'PATCH ^\\/api\\/requests\\/\\d+$',
    // 收藏：agent 目前沒有 companion 收藏工具
    'POST ^\\/api\\/poi-favorites$',
    'DELETE ^\\/api\\/poi-favorites\\/\\d+$',
    'POST ^\\/api\\/poi-favorites\\/\\d+\\/add-to-trip$',
    // trip-pois：agent 目前沒有對應 companion 工具
    'POST ^\\/api\\/trips\\/[^/]+\\/entries\\/\\d+\\/trip-pois$',
    'PATCH ^\\/api\\/trips\\/[^/]+\\/trip-pois\\/\\d+$',
    'DELETE ^\\/api\\/trips\\/[^/]+\\/trip-pois\\/\\d+$',
  ].sort();

  it('白名單中沒有任何 companion 工具對應的項目，恰好等於 API_ONLY', () => {
    const paths = contract.companionTools.map((t) => ({ method: t.method, path: concrete(t.path) }));
    const extra = COMPANION_ALLOWED
      .filter((a) => !paths.some((p) => p.method === a.method && a.pattern.test(p.path)))
      .map(key)
      .sort();
    expect(extra, 'api 多放行（或少放行）了項目：請確認是有意的，並同步 fixture／API_ONLY').toEqual(API_ONLY);
  });

  it('API_ONLY 沒有過期項目（每一項都真的在白名單裡）', () => {
    const all = COMPANION_ALLOWED.map(key);
    for (const k of API_ONLY) expect(all, k).toContain(k);
  });
});
