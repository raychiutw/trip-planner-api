/// <reference types="node" />
/**
 * delete-reauth staging smoke 腳本（trip-planner#1616）：安全閘、清理範圍、整套情境對本地 app 乾跑。
 * 乾跑用 createApp + 真 SQLite 當 Io，所以情境的判定邏輯（含失敗回滾、並行、token 撤銷）都被執行過；
 * 對 staging 的實跑結果另貼在票上。
 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';
import {
  assertStaging, cleanupSql, runScenarios, STAGING_D1, STAGING_ORIGIN, PREFIX, type Io,
} from '../scripts/smoke-delete-reauth';

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
    ['藏在其他參數裡的 production', ['--google-sub=x', '--note=Production']],
  ])('拒絕：%s', (_name, argv) => {
    expect(() => assertStaging(argv)).toThrow();
  });
});

describe('cleanupSql 只動自己的前綴', () => {
  it('清掉 smoke 前綴的列，其他列原封不動', async () => {
    const d1 = createD1();
    const add = (id: string) => {
      d1.raw.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id, `${id}@x.invalid`);
      d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)").run(id, `sub-${id}`);
      d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, 9e15)").run(`tok-${id}`, JSON.stringify({ user_id: id }));
      d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccountDeleteChallenge', ?, ?, 9e15)").run(`ch-${id}`, JSON.stringify({ uid: id }));
    };
    add(`${PREFIX}a`); add('real-user');
    for (const s of cleanupSql()) d1.raw.exec(s);
    const count = (t: string) => (d1.raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count('users'), count('auth_identities'), count('oauth_models')]).toEqual([1, 1, 2]);
    expect((d1.raw.prepare('SELECT id FROM users').get() as { id: string }).id).toBe('real-user');
    d1.close();
  });
});

describe('整套情境對本地 app 乾跑', () => {
  it('全部通過，且結束後前綴資料清乾淨', async () => {
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
    const results = await runScenarios(io);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining([
      '無 challenge', 'challenge 未完成', 'challenge 過期', '跨帳號', '重放', '失敗回滾後可重試', '並行兩次 DELETE', '成功後 token 撤銷',
    ]));
    expect(d1.raw.prepare("SELECT count(*) AS n FROM users WHERE id LIKE 'smoke1616-%'").get()).toEqual({ n: 0 });
    expect(d1.raw.prepare("SELECT count(*) AS n FROM oauth_models WHERE id LIKE 'smoke1616-%'").get()).toEqual({ n: 0 });
    expect(d1.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'smoke1616_%'").get()).toEqual({ n: 0 });
    d1.close();
  });
});
