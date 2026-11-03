/**
 * POST /api/oauth/mint-restricted 的 AI 資料同意檢查（ADR-0012 補強；舊入口 tests/api/ai-data-consent-mint.test.ts 的對應版）。
 * 入口閘門只擋「建立請求」；這裡驗證 agent 取得 owner 權限 token 前再檢查一次：
 * 涵蓋旗標啟用前已排隊的請求、撤回與建立請求同時發生漏網的請求。
 *
 * Value: protects=旗標開且文案填妥時，owner 或一般使用者送出者缺有效資料同意就不簽發 token、請求被終結並留 audit；服務／系統送出的請求只看 owner; fails_when=拿掉 mint 檢查、略過 owner 或送出者其中一方、旗標關閉時仍擋; why_new=oauth-mint-restricted-endpoint.test 不涵蓋資料同意; seam=none; no_claim=agent 端 spawn 行為（mint 失敗不 spawn 在 agent repo）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv, seedTrip, seedUser, userIdFor } from './helpers';
import { createApi, type Api } from './http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

const SECRET = 'mrs-dc-secret';
const CLIENT = 'tripline-tp-request';
const OWNER = 'mdc-owner@test.com';
const COLLAB = 'mdc-collab@test.com';
const TRIP = 'mdc-trip';
const V = 'ai-data-v1';

vi.mock('../../src/lib/ai-data-consent-text', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/lib/ai-data-consent-text')>();
  const fill = (s: string) => s.replaceAll('{{RESPONSIBLE_PARTY}}', '測試責任人').replaceAll('{{CONTACT_EMAIL}}', 'privacy@example.test').replaceAll('{{TERMS_URL}}', 'https://example.test/terms');
  return { ...m, CONSENT_TEXTS: Object.fromEntries(Object.entries(m.CONSENT_TEXTS).map(([k, v]) => [k, JSON.parse(fill(JSON.stringify(v)))])) };
});

let db: D1Database;
let apiOn: Api;
let apiOff: Api;
let ownerId: string;
const uid = userIdFor;

const seedConsent = (userId: string) =>
  new D1Adapter(db, 'Consent').upsert(`${userId}:${CLIENT}`, { user_id: userId, client_id: CLIENT, scopes: ['openid', 'profile'], grantedAt: 1 }, 300);
const seedEvent = (email: string, event: string, version = V) =>
  db.prepare('INSERT INTO ai_data_consent_events (user_id, version, event) VALUES (?, ?, ?)').bind(uid(email), version, event).run();
const clearEvents = () => db.prepare("DELETE FROM ai_data_consent_events WHERE user_id LIKE 'test-user-mdc-%'").run();
const seedRequest = async (submittedBy: string, status = 'open') =>
  (await db.prepare('INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id').bind(TRIP, 'mdc 測試', submittedBy, status).first<{ id: number }>())!.id;
const reqState = (id: number) => db.prepare('SELECT status, terminal_reason, reply FROM trip_requests WHERE id = ?').bind(id).first<{ status: string; terminal_reason: string | null; reply: string | null }>();
const tokens = async () => (await db.prepare("SELECT id FROM oauth_models WHERE name = 'AccessToken' AND json_extract(payload, '$.user_id') = ?").bind(ownerId).all()).results;
const audit = async () => (await db.prepare('SELECT outcome, failure_reason, metadata FROM auth_audit_log WHERE user_id = ? ORDER BY id').bind(ownerId).all<{ outcome: string; failure_reason: string | null; metadata: string }>()).results;
const mint = (id: number, api: Api = apiOn) =>
  api.request('POST', '/api/oauth/mint-restricted', { json: { request_id: id }, headers: { Authorization: `Bearer ${SECRET}` } });
const clean = async () => {
  await clearEvents();
  await db.prepare("DELETE FROM oauth_models WHERE name IN ('Consent','AccessToken') AND json_extract(payload, '$.user_id') = ?").bind(ownerId).run();
  await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(ownerId).run();
  await db.prepare('DELETE FROM trip_requests WHERE trip_id = ?').bind(TRIP).run();
};

beforeAll(async () => {
  db = await createTestDb();
  apiOn = createApi({ env: mockEnv(db, { TRIPLINE_API_SECRET: SECRET, AI_CONSENT_ENFORCED: 'true' }) });
  apiOff = createApi({ env: mockEnv(db, { TRIPLINE_API_SECRET: SECRET }) });
  ownerId = (await seedTrip(db, { id: TRIP, owner: OWNER })).ownerUserId;
  await seedUser(db, COLLAB);
}, 30000);

beforeEach(async () => { await clean(); await seedConsent(ownerId); });

afterAll(async () => {
  await clean();
  await disposeMiniflare();
});

describe('mint-restricted × AI 資料同意', () => {
  it('owner 與送出者都 valid → 簽發 token', async () => {
    await seedEvent(OWNER, 'accepted'); await seedEvent(COLLAB, 'accepted');
    const id = await seedRequest(COLLAB);
    const res = await mint(id);
    expect(res.status).toBe(200);
    expect(await tokens()).toHaveLength(1);
    expect((await reqState(id))!.status).toBe('open');
  });

  it('owner 沒有資料同意（旗標啟用前就排隊的請求）→ 403、不簽發、請求被終結為 needs_consent 並留 audit', async () => {
    const id = await seedRequest(OWNER);
    const res = await mint(id);
    expect(res.status).toBe(403);
    expect(await tokens()).toHaveLength(0);
    const st = await reqState(id);
    expect(st).toMatchObject({ status: 'failed', terminal_reason: 'needs_consent' });
    expect(st!.reply).toContain('AI 資料同意');
    const a = await audit();
    expect(a.at(-1)).toMatchObject({ outcome: 'failure', failure_reason: 'no_data_consent' });
    expect(JSON.parse(a.at(-1)!.metadata).missing).toBe('owner');
  });

  it('owner 撤回後才 mint（撤回與建立請求同時發生漏網的請求）→ 不簽發', async () => {
    await seedEvent(OWNER, 'accepted'); await seedEvent(OWNER, 'withdrawn');
    const id = await seedRequest(OWNER);
    expect((await mint(id)).status).toBe(403);
    expect(await tokens()).toHaveLength(0);
  });

  it('owner 有效但旅伴送出者沒同意 → 不簽發，缺的是 submitter', async () => {
    await seedEvent(OWNER, 'accepted');
    const id = await seedRequest(COLLAB);
    expect((await mint(id)).status).toBe(403);
    expect(await tokens()).toHaveLength(0);
    expect(JSON.parse((await audit()).at(-1)!.metadata).missing).toBe('submitter');
    expect(await reqState(id)).toMatchObject({ status: 'failed', terminal_reason: 'needs_consent' });
  });

  it('送出者是舊版同意（stale）→ 不簽發', async () => {
    await seedEvent(OWNER, 'accepted'); await seedEvent(COLLAB, 'accepted', 'ai-data-v0');
    const id = await seedRequest(COLLAB);
    expect((await mint(id)).status).toBe(403);
    expect(await reqState(id)).toMatchObject({ status: 'failed', terminal_reason: 'needs_consent' });
  });

  it('processing 狀態的請求（MINTABLE）缺 owner 同意 → 同樣 403、終結', async () => {
    const id = await seedRequest(OWNER, 'processing');
    expect((await mint(id)).status).toBe(403);
    expect(await tokens()).toHaveLength(0);
    expect(await reqState(id)).toMatchObject({ status: 'failed', terminal_reason: 'needs_consent' });
  });

  it('送出者 email 大小寫不同（legacy 未正規化）仍對得上使用者：旅伴沒同意 → 擋', async () => {
    await seedEvent(OWNER, 'accepted');
    expect((await mint(await seedRequest(COLLAB.toUpperCase()))).status).toBe(403);
  });

  it('submitted_by 為空字串 → 視為非使用者，只看 owner（owner valid → 簽發）', async () => {
    await seedEvent(OWNER, 'accepted');
    expect((await mint(await seedRequest(''))).status).toBe(200);
  });

  it('邊界：email 形狀但不在 users 內的 submitted_by 視為非使用者（只看 owner）；服務送出但 owner 缺同意仍擋', async () => {
    await seedEvent(OWNER, 'accepted');
    expect((await mint(await seedRequest('ghost@test.com'))).status).toBe(200); // 刻意的豁免邊界
    await clearEvents(); // owner 也沒同意了
    expect((await mint(await seedRequest('service:daily-check'))).status).toBe(403);
  });

  it('服務／系統送出的請求（submitted_by 不是使用者）只看 owner：owner 有效 → 簽發', async () => {
    await seedEvent(OWNER, 'accepted');
    const res = await mint(await seedRequest('service:daily-check'));
    expect(res.status).toBe(200);
  });

  it('旗標關閉：沒有任何同意也照常簽發（行為與現況相同）', async () => {
    const res = await mint(await seedRequest(COLLAB), apiOff);
    expect(res.status).toBe(200);
  });

  it('owner 自己送出：只查一次，owner valid → 簽發', async () => {
    await seedEvent(OWNER, 'accepted');
    expect((await mint(await seedRequest(OWNER))).status).toBe(200);
  });
});
