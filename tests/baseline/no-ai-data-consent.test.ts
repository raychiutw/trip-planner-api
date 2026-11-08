// @vitest-environment node
/**
 * 守門：AI 資料同意功能已整個移除（trip-planner#1615，owner 決議 2026-11-08）。
 *
 * 守的是「不得復活」：同意路由不在 OpenAPI、不可呼叫、src 不再引用同意相關識別字；
 * 三個受管制入口沒有任何同意閘門；帳號刪除仍清掉既有的同意紀錄（資料表保留，舊入口共用 production D1）。
 * 刻意不在範圍：ai-authorization（AI 操作授權，Consent grant）、needs_consent 終結原因、oauth_models 的 Consent。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';

const ROOT = join(__dirname, '../..');
const TRIP = 'nadc-trip';
const OWNER = 'nadc-owner@test.com';
const SOON_GONE = 'nadc-gone@test.com';
const KEEPER = 'nadc-keeper@test.com';

describe('AI 資料同意已移除', () => {
  let db: D1Database;
  let api: Api;

  beforeAll(async () => {
    db = await createTestDb();
    // 旗標即使被設了也不得有任何作用
    api = createApi({ env: mockEnv(db, { AI_CONSENT_ENFORCED: 'true' } as never) });
    await seedTrip(db, { id: TRIP, owner: OWNER });
  }, 30000);

  afterAll(async () => {
    await db.prepare("DELETE FROM ai_data_consent_events WHERE user_id LIKE 'test-user-nadc-%'").run();
    await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
    await cleanupTrips(db, [TRIP]);
    await disposeMiniflare();
  });

  it('OpenAPI 不含 ai-data-consent 路徑', async () => {
    const spec = (await (await createApp().request('/openapi.json', {}, mockEnv(db, {}))).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths).filter((p) => /ai-data-consent/i.test(p))).toEqual([]);
    expect(Object.keys(spec.paths)).toContain('/api/account/ai-authorization'); // 不同概念，必須還在
  });

  it.each(['GET', 'POST', 'DELETE'])('%s /api/account/ai-data-consent 回 404', async (method) => {
    const res = await api.request(method as 'GET', '/api/account/ai-data-consent', { as: OWNER, json: method === 'POST' ? { version: 'ai-data-v1' } : undefined });
    expect(res.status).toBe(404);
  });

  it('建立請求沒有同意閘門：即使旗標為 true、送出者沒有任何同意紀錄，照常 201', async () => {
    const res = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: '請幫我排行程 nadc' } });
    expect(res.status).toBe(201);
  });

  it('帳號刪除仍清掉該使用者既有的同意紀錄，別人的不動', async () => {
    const gone = userIdFor(SOON_GONE);
    const keep = userIdFor(KEEPER);
    for (const e of [SOON_GONE, KEEPER]) await seedUser(db, e);
    for (const u of [gone, keep]) await db.prepare("INSERT INTO ai_data_consent_events (user_id, version, event) VALUES (?, 'ai-data-v1', 'accepted')").bind(u).run();
    const { eraseUserAccount } = await import('../../src/lib/erasure');
    const summary = await eraseUserAccount(db, gone);
    expect(summary.tablesCleared.ai_data_consent_events).toBe(1);
    const left = (await db.prepare("SELECT user_id FROM ai_data_consent_events WHERE user_id LIKE 'test-user-nadc-%'").all<{ user_id: string }>()).results;
    expect(left.map((r) => r.user_id)).toEqual([keep]);
  });

  it('src 不再引用同意文案、閘門、旗標與錯誤碼（erasure 的資料表名稱是保留清理，不在此列）', () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', '-i', '-E', 'ai-data-consent|AI_CONSENT|aiDataConsent|assertAiConsent|consentGapAtMint|AiConsent|CONSENT_TEXTS|no_data_consent', '--', 'src', 'wrangler.toml'], { cwd: ROOT, encoding: 'utf8' });
    } catch { /* 無命中 exit 1 */ }
    expect(out.trim().split('\n').filter(Boolean)).toEqual([]);
  });
});
