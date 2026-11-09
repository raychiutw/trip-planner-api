/**
 * 「文案沒填妥就不能強制」：第一組測試守真實文案已無占位符且內容就是 owner 提供的；
 * 後兩組在 beforeAll 把占位符放回真實文案物件，守未完成時旗標開了也不強制、POST 不得記錄同意。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedEntry, getDayId } from './helpers';
import { createApi, type Api } from './http';
import { cleanupTrips } from './cleanup-trips';
import { CONSENT_TEXTS, CURRENT_CONSENT_VERSION } from '../../src/lib/ai-data-consent-text';
import { isConsentTextComplete, isConsentEnforced } from '../../src/lib/ai-data-consent';

const OWNER = 'aici-owner@test.com';
const TRIP = 'aici-trip';
let db: D1Database;
let api: Api;

const PLACEHOLDER_TEXT = '責任人：{{RESPONSIBLE_PARTY}}；聯絡信箱：{{CONTACT_EMAIL}}；條款：{{TERMS_URL}}';
const realSections = CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!.sections;
const withPlaceholders = () => {
  CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!.sections = [...realSections, { heading: '待填', items: [PLACEHOLDER_TEXT] }];
};
const restoreReal = () => {
  CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!.sections = realSections;
};

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { AI_CONSENT_ENFORCED: 'true' }) });
  await seedTrip(db, { id: TRIP, owner: OWNER });
  await seedEntry(db, await getDayId(db, TRIP, 1));
});
afterAll(async () => {
  await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_health_reports WHERE trip_id = ?').bind(TRIP).run();
  await db.prepare('DELETE FROM trip_note_ai_jobs WHERE trip_id = ?').bind(TRIP).run();
  await cleanupTrips(db, [TRIP]);
  await disposeMiniflare();
});

const textOf = () => JSON.stringify(CONSENT_TEXTS[CURRENT_CONSENT_VERSION]);

describe('文案', () => {
  it('目前版本是 ai-data-v1；占位符已填妥（責任人、信箱、條款連結），isConsentTextComplete() 為 true', () => {
    expect(CURRENT_CONSENT_VERSION).toBe('ai-data-v1');
    expect(textOf().match(/\{\{[A-Z_]+\}\}/g)).toBeNull();
    expect(textOf()).toContain('責任人：邱淞瑋；聯絡信箱：lean.lean@gmail.com');
    expect(textOf()).toContain('詳見連結：https://www.anthropic.com/legal/commercial-terms');
    expect(isConsentTextComplete()).toBe(true);
  });
  it('isConsentTextComplete 只要任何一個占位符還在就是 false；全部填妥才 true', () => {
    const full = { version: 'x', title: 't', intro: 'i', sections: [{ heading: 'h', items: ['a'] }], withdrawal: ['w'] };
    expect(isConsentTextComplete(full)).toBe(true);
    for (const p of ['{{RESPONSIBLE_PARTY}}', '{{CONTACT_EMAIL}}', '{{TERMS_URL}}', '{{ANYTHING}}']) {
      expect(isConsentTextComplete({ ...full, sections: [{ heading: 'h', items: ['a', `聯絡 ${p}`] }] })).toBe(false);
      expect(isConsentTextComplete({ ...full, title: p })).toBe(false);
      expect(isConsentTextComplete({ ...full, withdrawal: [p] })).toBe(false);
    }
  });
  it('已定案的措辭：顯示名稱不含 email、每次修改留下紀錄、Anthropic（Claude）、依處理方條款；不寫可復原／不用於訓練／立即停止', () => {
    const t = textOf();
    expect(t).toContain('顯示名稱');
    expect(t).toContain('顯示名稱（不含 email）');
    expect(t).toMatch(/不會交給 AI：[^。"]*帳號 email/);
    expect(t).toContain('每次修改都會留下紀錄');
    expect(t).toContain('Anthropic（Claude）');
    expect(t).toContain('依處理方條款，詳見連結');
    expect(t).not.toMatch(/復原|不用於訓練|立即停止/);
    // 撤回語意照實寫
    expect(t).toContain('已經開始的工作');
    expect(t).toContain('無法收回');
  });
  it('文字已完成：旗標開 → isConsentEnforced 為 true；旗標關 → false（上線仍由旗標決定）', () => {
    expect(isConsentEnforced({ AI_CONSENT_ENFORCED: 'true' })).toBe(true);
    expect(isConsentEnforced({})).toBe(false);
  });
  it('旗標開但文字未完成 → isConsentEnforced 為 false', () => {
    withPlaceholders();
    try {
      expect(isConsentEnforced({ AI_CONSENT_ENFORCED: 'true' })).toBe(false);
    } finally {
      restoreReal();
    }
  });
});

describe('文案未填妥：POST 不得記錄同意', () => {
  beforeAll(withPlaceholders);
  afterAll(restoreReal);
  it('POST → 409 AI_CONSENT_NOT_READY（帶 currentVersion），不寫入事件；GET 與 DELETE 不受影響', async () => {
    const res = await api.request('POST', '/api/account/ai-data-consent', { as: OWNER, json: { version: 'ai-data-v1' } });
    expect(res.status).toBe(409);
    const b = await res.json() as any;
    expect(b.error.code).toBe('AI_CONSENT_NOT_READY');
    expect(b.error.currentVersion).toBe('ai-data-v1');
    const n = await db.prepare('SELECT COUNT(*) AS n FROM ai_data_consent_events').first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect((await api.get('/api/account/ai-data-consent', { as: OWNER })).status).toBe(200);
    expect((await api.request('DELETE', '/api/account/ai-data-consent', { as: OWNER })).status).toBe(200);
    // 版本不符仍優先回 MISMATCH（不因未就緒而改變）
    const mm = await api.request('POST', '/api/account/ai-data-consent', { as: OWNER, json: { version: 'ai-data-v999' } });
    expect(((await mm.json()) as any).error.code).toBe('AI_CONSENT_VERSION_MISMATCH');
  });
});

describe('旗標開、文案未完成：不擋', () => {
  beforeAll(withPlaceholders);
  afterAll(restoreReal);
  it('GET 狀態：enforced=false', async () => {
    const res = await api.get('/api/account/ai-data-consent', { as: OWNER });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).enforced).toBe(false);
  });
  it('三個入口在完全沒有同意時照常受理', async () => {
    const r1 = await api.request('POST', '/api/requests', { as: OWNER, json: { tripId: TRIP, message: '未完成文案也不擋' } });
    expect(r1.status).toBe(201);
    const r2 = await api.request('POST', `/api/trips/${TRIP}/health-check`, { as: OWNER });
    expect(r2.status).toBe(202);
    const r3 = await api.request('POST', `/api/trips/${TRIP}/notes/tips/generate`, { as: OWNER, json: {} });
    expect(r3.status).toBe(202);
  });
});
