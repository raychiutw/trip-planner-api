/// <reference types="node" />
/**
 * ai-consent staging smoke 腳本（trip-planner#1615）：安全閘、清理範圍、整套情境對本地 app 乾跑。
 * 乾跑用 createApp + 真 SQLite 當 Io。閘門永遠強制（沒有旗標），唯一的不強制路徑是文案仍含占位符，
 * 所以「不強制組」靠臨時塞入占位符模擬，兩組情境的判定邏輯都被執行過。
 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';
import { CONSENT_TEXTS, CURRENT_CONSENT_VERSION } from '../src/lib/ai-data-consent-text';
import {
  assertStaging, cleanupSql, runScenarios, STAGING_D1, STAGING_ORIGIN, PREFIX, type Io,
} from '../scripts/smoke-ai-consent';

describe('安全閘 assertStaging', () => {
  it('預設值與明確的 staging 值通過', () => {
    expect(assertStaging([])).toEqual({ baseUrl: STAGING_ORIGIN, d1: STAGING_D1 });
    expect(assertStaging([`--base-url=${STAGING_ORIGIN}/`, `--d1=${STAGING_D1}`]).baseUrl).toBe(STAGING_ORIGIN);
  });

  it.each([
    ['production base url', ['--base-url=https://trip-planner-api-production.lean-lean.workers.dev']],
    ['production d1 名稱', ['--d1=trip-planner-db']],
    ['含 -production 字樣的 d1', ['--d1=trip-planner-db-production']],
    ['--env production', ['--env', 'production']],
    ['--env=production', ['--env=production']],
    ['-e production', ['-e', 'production']],
    ['任意 --env', ['--env=staging']],
    ['非白名單網址', ['--base-url=https://example.com']],
    ['網址只是前綴相同的假網域', [`--base-url=${STAGING_ORIGIN}.evil.com`]],
    ['http 而非 https', ['--base-url=http://trip-planner-api.lean-lean.workers.dev']],
    ['非白名單 d1', ['--d1=some-other-db']],
    ['無法解析的網址', ['--base-url=not a url']],
    ['藏在其他參數裡的 production', ['--note=Production']],
  ])('拒絕：%s', (_name, argv) => {
    expect(() => assertStaging(argv)).toThrow();
  });
});

describe('cleanupSql 只動自己的前綴', () => {
  it('清掉 smoke 前綴的列，其他列原封不動', () => {
    const d1 = createD1();
    const add = (u: string, t: string) => {
      d1.raw.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(u, `${u}@x.invalid`);
      d1.raw.prepare('INSERT INTO trips (id, name, owner_user_id, title, countries, published) VALUES (?, ?, ?, ?, ?, 0)').run(t, t, u, t, 'JP');
      d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES (?, ?, 'owner')").run(u, t);
      d1.raw.prepare("INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, 'm', ?, 'open')").run(t, `${u}@x.invalid`);
      d1.raw.prepare("INSERT INTO audit_log (trip_id, table_name, action, changed_by) VALUES (?, 't', 'insert', 'x')").run(t);
      d1.raw.prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start) VALUES (?, 1, 0)').run(`ai-request:user:${u}`);
      d1.raw.prepare("INSERT INTO ai_data_consent_events (user_id, version, event) VALUES (?, 'v', 'accepted')").run(u);
      d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, 9e15)").run(`tok-${u}`, JSON.stringify({ user_id: u }));
    };
    add(`${PREFIX}a`, `${PREFIX}a-trip`); add('real-user', 'real-trip');
    for (const s of cleanupSql()) d1.raw.exec(s);
    for (const t of ['users', 'trips', 'trip_permissions', 'trip_requests', 'ai_data_consent_events', 'oauth_models', 'audit_log', 'rate_limit_buckets']) {
      expect((d1.raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(1);
    }
    expect((d1.raw.prepare('SELECT id FROM users').get() as { id: string }).id).toBe('real-user');
    d1.close();
  });
});

function localIo() {
  const d1 = createD1();
  const env = { DB: d1.db, ENVIRONMENT: 'preview', PUBLIC_ORIGIN: STAGING_ORIGIN, ALLOWED_ORIGINS: '' } as unknown as Env;
  const io: Io = {
    async sql(s) {
      if (/^\s*SELECT/i.test(s)) return d1.raw.prepare(s).all() as Record<string, unknown>[];
      d1.raw.exec(s);
      return [];
    },
    async http(method, path, token, body) {
      const res = await createApp().request(path, {
        method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, env);
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
  return { d1, io };
}

/** 全部資料表的筆數快照：乾跑前後相等＝殘留為 0。 */
// api_logs 是每個請求都寫的通用存取紀錄，無前綴可歸屬，排除（腳本也不刪它）。
const snapshot = (d1: ReturnType<typeof createD1>) =>
  Object.fromEntries((d1.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'api_logs'").all() as { name: string }[])
    .map(({ name }) => [name, (d1.raw.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n]));

describe('整套情境對本地 app 乾跑', () => {
  it('文案仍含占位符（保險，不強制）：不強制組全過、強制組為 SKIP、殘留為 0', async () => {
    const realSections = CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!.sections;
    CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!.sections = [...realSections, { heading: '待填', items: ['責任人：{{RESPONSIBLE_PARTY}}'] }];
    try {
    const { d1, io } = localIo();
    const before = snapshot(d1);
    const results = await runScenarios(io, { withRequests: true });
    expect(results.filter((r) => r.status === 'FAIL')).toEqual([]);
    expect(results.filter((r) => r.status === 'PASS').map((r) => r.name)).toEqual(expect.arrayContaining([
      '同意狀態端點 GET', '版本不符 POST → 409 且不寫入', '不強制：owner 沒有同意也放行（201）', '不強制：旅伴沒有同意、owner 也沒有 → 放行（201）',
    ]));
    expect(results.filter((r) => r.status === 'SKIP').map((r) => r.name)).toEqual(expect.arrayContaining(['強制：未同意被攔 403 AI_CONSENT_REQUIRED', 'erasure 清除同意紀錄']));
    expect(snapshot(d1)).toEqual(before);
    d1.close();
    } finally {
      CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!.sections = realSections;
    }
  });

  it('預設（不帶 --with-requests）：不建立任何 trip_request，request 步驟為 SKIP', async () => {
    const { d1, io } = localIo();
    const results = await runScenarios(io);
    expect(results.filter((r) => r.status === 'FAIL')).toEqual([]);
    expect(results.filter((r) => r.status === 'SKIP' && r.detail.includes('--with-requests')).length).toBeGreaterThanOrEqual(2);
    expect((d1.raw.prepare('SELECT count(*) AS n FROM trip_requests').get() as { n: number }).n).toBe(0);
    d1.close();
  });

  it('強制（不需旗標）：強制組全過（403／旅伴 OWNER_REQUIRED／同意後放行／撤回再被攔）、殘留為 0', async () => {
    const { d1, io } = localIo();
    const before = snapshot(d1);
    const results = await runScenarios(io, { withRequests: true });
    expect(results.filter((r) => r.status === 'FAIL')).toEqual([]);
    expect(results.filter((r) => r.status === 'PASS').map((r) => r.name)).toEqual(expect.arrayContaining([
      '強制：未同意被攔 403 AI_CONSENT_REQUIRED', '強制：旅伴送出、owner 未同意 → AI_CONSENT_OWNER_REQUIRED', '強制：同意後放行', '強制：撤回後再次被攔',
    ]));
    expect(results.some((r) => r.name.startsWith('不強制'))).toBe(false);
    expect(snapshot(d1)).toEqual(before);
    d1.close();
  });
});
