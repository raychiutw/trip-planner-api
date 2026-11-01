/**
 * POST /api/oauth/login — 第一方（web／行動端）以帳密直接換 authorization code，不跳轉、不發 cookie。
 * 之後走既有的 token endpoint（PKCE，可選 DPoP 綁定）兌換成 token。
 * 走 HTTP 邊界；真 SQLite（全部 migrations，含 0099 的 tripline-web 等第一方 client）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../src/lib/password', async (orig) => {
  const m = await orig<typeof import('../src/lib/password')>();
  return { ...m, verifyPassword: vi.fn(m.verifyPassword) };
});

import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { createD1 } from './support/d1';
import { newKey, proof } from './support/dpop';

let d1: ReturnType<typeof createD1>;
let env: Env;
let HASH: string;
const verifyMock = vi.mocked(verifyPassword);

const PASSWORD = 'correct-horse-battery';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  HASH ??= await hashPassword(PASSWORD);
  addUser('u1', 'alice@example.com', HASH);
  verifyMock.mockClear();
});
afterEach(() => { d1.close(); vi.restoreAllMocks(); });

function addUser(id: string, email: string, hash: string | null, status = 'active') {
  d1.raw.prepare('INSERT INTO users (id, email, status) VALUES (?, ?, ?)').run(id, email, status);
  d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')").run(id, email, hash);
}
const base = { email: 'alice@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' };
function login(over: Record<string, unknown> = {}, ip = '1.1.1.1', raw?: string) {
  return createApp().request('/api/oauth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: raw ?? JSON.stringify({ ...base, ...over }),
  }, env);
}
const code = async (res: Response) => ((await res.json()) as { code: string }).code;
const exchange = (c: string, extra: Record<string, string> = {}, dpop?: string) => {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' });
  if (dpop) headers.set('DPoP', dpop);
  return createApp().request('/api/oauth/token', { method: 'POST', headers, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'tripline-web', code: c, code_verifier: VERIFIER, ...extra }).toString() }, env);
};
const codeRows = () => d1.raw.prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'AuthorizationCode'").all() as { id: string; payload: string; expires_at: number }[];
const bucket = (like: string) => d1.raw.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key LIKE ?').get(like) as { count: number } | undefined;
type Err = { error: { code: string; message: string } };

describe('成功', () => {
  it('回 code（不發 cookie、no-store），回應只有 code 與 expires_in', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'expires_in']);
    expect(body.expires_in).toBe(60);
  });
  it('code 的內容：綁定 client、使用者、PKCE；沒有 redirect_uri；預設 scope；60 秒有效', async () => {
    await login();
    const [row] = codeRows();
    expect(JSON.parse(row!.payload)).toMatchObject({ client_id: 'tripline-web', user_id: 'u1', redirect_uri: null, scopes: ['openid', 'profile', 'email'], code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    expect(Math.abs(row!.expires_at - (Date.now() + 60_000))).toBeLessThan(3000);
  });
  it('端到端：code 在 token endpoint 兌換成可用的 token（不需 redirect_uri）', async () => {
    const res = await exchange(await code(await login()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_type: 'Bearer', scope: 'openid profile email' });
  });
  it('email 前後空白與大小寫不影響', async () => {
    expect((await login({ email: '  ALICE@Example.COM ' })).status).toBe(200);
  });
  it('可要求較小的 scope', async () => {
    await login({ scope: 'openid profile' });
    expect(JSON.parse(codeRows()[0]!.payload).scopes).toEqual(['openid', 'profile']);
  });
  it('寫入 audit（成功、含 client），並更新 last_used_at', async () => {
    await login();
    const ev = d1.raw.prepare("SELECT outcome, client_id, user_id FROM auth_audit_log WHERE event_type = 'login'").all();
    expect(ev).toEqual([{ outcome: 'success', client_id: 'tripline-web', user_id: 'u1' }]);
    expect((d1.raw.prepare("SELECT last_used_at FROM auth_identities WHERE user_id = 'u1'").get() as { last_used_at: string | null }).last_used_at).toBeTruthy();
  });
});

describe('DPoP 綁定', () => {
  it('帶 dpop_jkt：code 綁定該金鑰；兌換必須由同一把金鑰簽 proof', async () => {
    const key = await newKey(); const other = await newKey();
    const c = await code(await login({ dpop_jkt: key.jkt }));
    expect((await exchange(c)).status).toBe(400);                                   // 沒帶 proof
    const c2 = await code(await login({ dpop_jkt: key.jkt }));
    expect((await exchange(c2, {}, await proof(other))).status).toBe(400);          // 別把金鑰
    const c3 = await code(await login({ dpop_jkt: key.jkt }));
    const ok = await exchange(c3, {}, await proof(key, { htu: 'http://localhost/api/oauth/token' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token_type: 'DPoP' });
  });
  it('dpop_jkt 格式不對 → 400', async () => {
    for (const bad of ['short', 'x'.repeat(44), 42, '!'.repeat(43)]) expect((await login({ dpop_jkt: bad })).status).toBe(400);
  });
});

describe('一律 401 LOGIN_INVALID（不洩漏帳號是否存在）', () => {
  const expectInvalid = async (res: Response) => {
    expect(res.status).toBe(401);
    const b = await res.json() as Err;
    expect(b.error.code).toBe('LOGIN_INVALID');
    return b;
  };
  it('密碼錯與帳號不存在：回應內容完全相同，且都不發 code', async () => {
    const a = await expectInvalid(await login({ password: 'wrong' }));
    const b = await expectInvalid(await login({ email: 'ghost@example.com' }));
    expect(a).toEqual(b);
    expect(codeRows()).toHaveLength(0);
  });
  it('帳號不存在也照樣做一次密碼雜湊運算（避免用回應時間猜帳號）', async () => {
    await login({ email: 'ghost@example.com' });
    expect(verifyMock).toHaveBeenCalledTimes(1);
    // 比對的是真正的 PBKDF2 假雜湊（耗時與真的相同），不是空字串這類立刻回傳的值
    expect(verifyMock.mock.calls[0]![1]).toMatch(/^pbkdf2\$100000\$/);
  });
  it('停權的帳號，即使密碼正確 → 同樣的 401，不發 code', async () => {
    addUser('u2', 'sus@example.com', HASH, 'suspended');
    await expectInvalid(await login({ email: 'sus@example.com' }));
    expect(codeRows()).toHaveLength(0);
  });
  it('只有 Google 登入、沒有密碼雜湊的帳號 → 同樣的 401（不是 500）', async () => {
    addUser('u3', 'g@example.com', null);
    await expectInvalid(await login({ email: 'g@example.com' }));
  });
  it('失敗寫入 audit：區分原因，但只進資料庫，不進回應', async () => {
    addUser('u3', 'g@example.com', null); addUser('u2', 'sus@example.com', HASH, 'suspended');
    await login({ password: 'wrong' }); await login({ email: 'ghost@example.com' });
    await login({ email: 'g@example.com' }); await login({ email: 'sus@example.com' });
    const reasons = (d1.raw.prepare("SELECT failure_reason FROM auth_audit_log WHERE outcome = 'failure' ORDER BY id").all() as { failure_reason: string }[]).map((r) => r.failure_reason);
    expect(reasons).toEqual(['wrong_password', 'unknown_email', 'no_password', 'account_suspended']);
  });
});

describe('輸入檢查 → 400 LOGIN_INVALID_INPUT（在做任何密碼運算之前）', () => {
  const bad: [string, Record<string, unknown> | string][] = [
    ['缺 email', { email: undefined }], ['缺 password', { password: undefined }], ['空 password', { password: '' }],
    ['email 不是字串', { email: { a: 1 } }], ['password 是陣列', { password: ['x'] }],
    ['password 過長（>1024）', { password: 'p'.repeat(1025) }],
    ['缺 client_id', { client_id: undefined }],
    ['缺 code_challenge', { code_challenge: undefined }],
    ['code_challenge_method=plain', { code_challenge_method: 'plain' }],
    ['code_challenge 長度不對', { code_challenge: 'abc' }],
    ['code_challenge 含不合法字元', { code_challenge: '!'.repeat(43) }],
    ['scope 超出 client 允許的範圍', { scope: 'openid admin:all' }],
    ['不是 JSON', '{oops'], ['JSON 但不是物件', '[1,2]'],
  ];
  for (const [name, over] of bad) {
    it(name, async () => {
      const res = typeof over === 'string' ? await login({}, '1.1.1.1', over) : await login(over);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Err).error.code).toBe('LOGIN_INVALID_INPUT');
      expect(verifyMock).not.toHaveBeenCalled();
      expect(codeRows()).toHaveLength(0);
    });
  }
});

describe('只有第一方 client 可以用', () => {
  beforeEach(() => {
    const ins = d1.raw.prepare("INSERT INTO client_apps (client_id, client_secret_hash, client_type, app_name, redirect_uris, allowed_scopes, status, first_party) VALUES (?, ?, ?, 'x', '[]', '[\"openid\"]', ?, ?)");
    ins.run('partner', null, 'public', 'active', 0);
    ins.run('first-conf', HASH, 'confidential', 'active', 1);
    ins.run('first-off', null, 'public', 'suspended', 1);
  });
  for (const id of ['partner', 'first-conf', 'first-off', 'ghost', 'tripline-tp-request']) {
    it(`client_id=${id} → 400，且不驗密碼、不計失敗次數`, async () => {
      const res = await login({ client_id: id, scope: undefined });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Err).error.code).toBe('LOGIN_INVALID_INPUT');
      expect(verifyMock).not.toHaveBeenCalled();
      expect(bucket('login:%')).toBeUndefined();
    });
  }
  it('不同的拒絕原因回應內容相同（不洩漏 client 的設定）', async () => {
    const a = await (await login({ client_id: 'partner', scope: undefined })).text();
    const b = await (await login({ client_id: 'ghost', scope: undefined })).text();
    expect(a).toBe(b);
  });
});

describe('限流', () => {
  const failFor = (n: number, mk: (i: number) => { over: Record<string, unknown>; ip: string }) =>
    Promise.all(Array.from({ length: n }, () => 0)).then(async () => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) { const { over, ip } = mk(i); out.push((await login(over, ip)).status); }
      return out;
    });

  it('同一 email 的嘗試上限是 5 次：前 5 次 401，第 6 次起 429（連密碼正確也被擋）', async () => {
    const statuses = await failFor(5, (i) => ({ over: { password: 'wrong' }, ip: `9.9.9.${i}` }));
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    const locked = await login({}, '9.9.9.9');
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(((await locked.json()) as Err).error.code).toBe('LOGIN_RATE_LIMITED');
  });

  it('併發猜密碼也不能超過上限：同時 10 個請求，恰好 5 個進到密碼比對，其餘 429', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => login({ password: `guess-${i}` }, `5.5.5.${i}`)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
    expect(verifyMock).toHaveBeenCalledTimes(5); // 被擋的請求連雜湊都不做
  });

  it('不存在的 email 一樣會鎖（行為相同，不能用鎖定與否判斷帳號存在）', async () => {
    await failFor(5, (i) => ({ over: { email: 'ghost@example.com', password: 'x' }, ip: `8.8.8.${i}` }));
    expect((await login({ email: 'ghost@example.com', password: 'x' }, '8.8.8.9')).status).toBe(429);
  });

  it('同一 IP 累積失敗 20 次後，連換 email 也被擋；訊息與 email 鎖定相同', async () => {
    const statuses = await failFor(20, (i) => ({ over: { email: `u${i}@example.com`, password: 'x' }, ip: '7.7.7.7' }));
    expect(statuses.every((s) => s === 401)).toBe(true);
    await login({ email: 'u20@example.com', password: 'x' }, '7.7.7.7'); // 第 21 次失敗觸發鎖定
    const byIp = await login({ email: 'fresh@example.com' }, '7.7.7.7');
    expect(byIp.status).toBe(429);
    await failFor(5, (i) => ({ over: { password: 'wrong' }, ip: `6.6.6.${i}` }));
    const byEmail = await login({}, '6.6.6.9');
    expect(await byIp.json()).toEqual(await byEmail.json());
  });

  it('穿插成功登入不能清掉 IP 的失敗計數（否則攻擊者用自己的帳號就能無限試別人的）', async () => {
    for (let i = 0; i < 21; i++) {
      expect((await login({ email: `v${i}@example.com`, password: 'x' }, '4.4.4.4')).status).toBe(401);
      if (i % 5 === 4) expect((await login({}, '4.4.4.4')).status).toBe(200); // 自己的帳號成功登入
    }
    expect((await login({ email: 'next@example.com', password: 'x' }, '4.4.4.4')).status).toBe(429);
  });

  it('成功登入只清掉該 email 的計數，不清 IP 的', async () => {
    for (let i = 0; i < 3; i++) await login({ password: 'wrong' });
    expect((await login()).status).toBe(200);
    expect(bucket('login:alice@example.com')).toBeUndefined();
    expect(bucket('login:1.1.1.1')!.count).toBe(3);
  });

  it('被鎖的 email 在鎖定期間，其他 email 不受影響', async () => {
    await failFor(6, (i) => ({ over: { password: 'wrong' }, ip: `3.3.3.${i}` }));
    addUser('u9', 'bob@example.com', HASH);
    expect((await login({ email: 'bob@example.com' }, '3.3.3.200')).status).toBe(200);
  });
});

describe('請求大小', () => {
  it('以位元組計：字元數沒超過、位元組超過 16KB 的 body 一樣被拒', async () => {
    // 認證資料都合法，只有無關欄位很大：6000 個中文字 ≈ 18000 位元組（字元數 < 16384）
    const res = await login({ junk: '中'.repeat(6000) });
    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });
  it('超大的 body 只讀到上限就中止，不會整個讀進記憶體', async () => {
    let pulled = 0;
    const stream = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024).fill(65)); if (pulled > 5000) c.close(); } });
    const res = await createApp().request('/api/oauth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' }, body: stream, duplex: 'half',
    } as RequestInit, env);
    expect(res.status).toBe(400);
    expect(pulled).toBeLessThan(100);
  });
});

describe('token endpoint：第一方 code 的 redirect_uri 規則', () => {
  it('第一方 code 兌換時若帶了 redirect_uri → 拒絕（該 code 沒有 redirect_uri）', async () => {
    const c = await code(await login());
    const res = await exchange(c, { redirect_uri: 'https://evil.example/cb' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('不外洩', () => {
  it('密碼不出現在任何 console 輸出、回應或資料庫（audit／oauth_models）', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const pw = 'sup3r-secret-pw-xyz';
    const wrong = await login({ password: pw });
    await login({ email: 'ghost@example.com', password: pw });
    const ok = await login(); // 正確密碼的成功路徑也要檢查
    const texts = [await wrong.text(), JSON.stringify(Object.fromEntries(ok.headers))];
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
    const dump = JSON.stringify([d1.raw.prepare('SELECT * FROM auth_audit_log').all(), d1.raw.prepare('SELECT * FROM oauth_models').all()]);
    for (const t of [...texts, logged, dump]) { expect(t).not.toContain(pw); expect(t).not.toContain(PASSWORD); }
  });
  it('audit 內的 ip 是雜湊，不是明文', async () => {
    await login({ password: 'wrong' }, '203.0.113.77');
    const dump = JSON.stringify(d1.raw.prepare('SELECT * FROM auth_audit_log').all());
    expect(dump).not.toContain('203.0.113.77');
  });
});
