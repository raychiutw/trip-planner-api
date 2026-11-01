/**
 * signup 組（註冊／驗證／忘記密碼／分享）契約測試：實際回應必須符合 OpenAPI 文件的 schema（多出欄位也會失敗）。
 * 走 HTTP 邊界；資料一律用 `sgc-` 前綴與專屬 IP，結束時只清自己的資料。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { z } from '@hono/zod-openapi';
import { createTestDb, disposeMiniflare } from '../baseline/setup';
import { mockEnv, seedTrip } from '../baseline/helpers';
import { createApi, type Api } from '../baseline/http';
import { seedInvitation, INVITE_SECRET } from '../baseline/invitations-http';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { sha256Base64 } from '../../src/lib/utils';
import { ApiError } from '../../src/schemas/common';
import { expectContract, contractIssues } from './support';
import * as S from '../../src/schemas/signup';

type Z = z.ZodTypeAny;
let db: D1Database;
let api: Api;
let seq = 0;
const ownerEmail = 'sgc-owner@test.com';
const viewerEmail = 'sgc-stranger@test.com';
const ips: string[] = [];
const userIds: string[] = [];
const tripIds: string[] = [];

/** 每個路由實際打過的狀態碼，最後一個測試用來確認「文件列的狀態碼都有被觸發」。 */
const hits = new Set<string>();
let doc: { paths: Record<string, Record<string, { responses: Record<string, unknown>; requestBody?: unknown; security?: unknown[] }>> };
const openapiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const ROUTES: Array<{ method: string; path: string; auth: 'none' | 'required'; body: boolean }> = [
  { method: 'post', path: '/api/oauth/signup', auth: 'none', body: true },
  { method: 'post', path: '/api/oauth/verify', auth: 'none', body: true },
  { method: 'get', path: '/api/oauth/verify', auth: 'none', body: false },
  { method: 'post', path: '/api/oauth/send-verification', auth: 'none', body: true },
  { method: 'post', path: '/api/oauth/forgot-password', auth: 'none', body: true },
  { method: 'post', path: '/api/oauth/reset-password', auth: 'none', body: true },
  { method: 'get', path: '/api/share/:token', auth: 'none', body: false },
  { method: 'post', path: '/api/share/:token/clone', auth: 'required', body: false },
  { method: 'get', path: '/api/trips/:id/shares', auth: 'required', body: false },
  { method: 'post', path: '/api/trips/:id/shares', auth: 'required', body: true },
  { method: 'patch', path: '/api/trips/:id/shares/:shareId', auth: 'required', body: true },
  { method: 'delete', path: '/api/trips/:id/shares/:shareId', auth: 'required', body: false },
];

/** 驗證狀態碼已寫進文件，並用文件 schema 嚴格檢查 body；schema 省略代表該狀態碼沒有 JSON。 */
async function check(route: string, res: Response, status: number, schema?: Z): Promise<unknown> {
  const [method, path] = route.split(' ') as [string, string];
  expect(res.status, `${route} 狀態碼`).toBe(status);
  const documented = doc.paths[openapiPath(path)]?.[method.toLowerCase()]?.responses ?? {};
  expect(Object.keys(documented), `${route} ${status} 沒有寫進文件`).toContain(String(status));
  hits.add(`${route} ${status}`);
  if (!schema) return null;
  const body = await res.json();
  expectContract(schema, body);
  return body;
}

function freshIp(): string {
  const ip = `198.18.${Math.floor(++seq / 250)}.${seq % 250 + 1}`;
  ips.push(ip);
  return ip;
}
/** 請求 body 的文件 schema（與路由 docs.body 同一份）；文件不在執行期驗證，所以測試自己驗送出的 body。 */
const BODY: Record<string, Z> = {
  '/api/oauth/signup': S.Signup_SignupBody,
  '/api/oauth/verify': S.Signup_VerifyBody,
  '/api/oauth/send-verification': S.Signup_EmailBody,
  '/api/oauth/forgot-password': S.Signup_EmailBody,
  '/api/oauth/reset-password': S.Signup_ResetPasswordBody,
};
/** 送出前先確認 body 符合文件 schema（含有值的選填欄位型別）。 */
const sent = <T>(schema: Z, body: T): T => { expectContract(schema, body); return body; };
const post = (path: string, json: unknown, ip = freshIp(), extra: Record<string, string> = {}) =>
  api.request('POST', path, { json: sent(BODY[path]!, json), headers: { 'CF-Connecting-IP': ip, ...extra } });
/** 對照組：文件的 body schema 判定不合法，handler 也實際拒絕（呼叫端再斷言 handler 的拒絕）。 */
const postBad = (path: string, json: unknown, ip = freshIp()) => {
  expect(contractIssues(BODY[path]!, json).length, `文件 schema 應判定不合法：${JSON.stringify(json)}`).toBeGreaterThan(0);
  return api.request('POST', path, { json, headers: { 'CF-Connecting-IP': ip } });
};

async function lock(key: string) {
  await db.prepare('INSERT OR REPLACE INTO rate_limit_buckets (bucket_key, count, window_start, locked_until) VALUES (?, 99, ?, ?)')
    .bind(key, Date.now(), Date.now() + 3_600_000).run();
}

async function seedAccount(name: string, opts: { provider?: 'local' | 'google'; verified?: boolean } = {}) {
  const id = `sgc-${name}-${++seq}`;
  const email = `sgc-${name}-${seq}@test.com`;
  const provider = opts.provider ?? 'local';
  await db.prepare('INSERT INTO users (id, email, display_name, email_verified_at) VALUES (?, ?, ?, ?)')
    .bind(id, email, name, opts.verified ? new Date().toISOString() : null).run();
  await db.prepare('INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, ?, ?, ?, ?)')
    .bind(id, provider, provider === 'local' ? email : `sub-${id}`, provider === 'local' ? 'x' : null, provider === 'local' ? 'pbkdf2' : null).run();
  userIds.push(id);
  return { id, email };
}

async function seedShare(tripId: string, body: Record<string, unknown> = {}): Promise<{ id: number; token: string }> {
  const res = await api.request('POST', `/api/trips/${tripId}/shares`, { as: ownerEmail, json: body });
  return (await res.json()) as { id: number; token: string };
}

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, { SESSION_SECRET: INVITE_SECRET }) });
  doc = (await (await api.get('/openapi.json')).json()) as typeof doc;
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); });

afterAll(async () => {
  for (const id of tripIds) {
    for (const t of ['trip_shares', 'trip_days', 'trip_permissions']) await db.prepare(`DELETE FROM ${t} WHERE trip_id = ?`).bind(id).run();
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  // clone 出來的行程
  const cloned = await db.prepare("SELECT t.id FROM trips t JOIN users u ON u.id = t.owner_user_id WHERE u.email LIKE 'sgc-%'").all<{ id: string }>();
  for (const { id } of cloned.results) {
    for (const t of ['trip_days', 'trip_permissions', 'trip_destinations', 'trip_shares', 'audit_log']) await db.prepare(`DELETE FROM ${t} WHERE trip_id = ?`).bind(id).run();
    await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
  }
  for (const id of userIds) {
    await db.prepare("DELETE FROM oauth_models WHERE name IN ('EmailVerification','PasswordReset') AND json_extract(payload, '$.userId') = ?").bind(id).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  // 以 signup 自己建的帳號
  const signed = await db.prepare("SELECT id FROM users WHERE email LIKE 'sgc-signup-%'").all<{ id: string }>();
  for (const { id } of signed.results) {
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await db.prepare("DELETE FROM users WHERE email LIKE 'sgc-%'").run();
  for (const ip of ips) {
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${ip}`).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE ip_hash = ?').bind(await sha256Base64(ip)).run();
  }
  await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_key LIKE '%sgc-%'").run();
  await db.prepare("DELETE FROM audit_log WHERE changed_by LIKE 'sgc-%'").run();
  await disposeMiniflare();
});

describe('文件覆蓋：每一條路由都有 schema', () => {
  it.each(ROUTES)('$method $path 有 requestBody／responses／security', ({ method, path, auth, body }) => {
    const op = doc.paths[openapiPath(path)]?.[method];
    expect(op, '路由未登記').toBeDefined();
    const responses = op!.responses as Record<string, { description?: string; content?: Record<string, unknown> }>;
    // 預設文件（尚未補 schema）的描述固定是「OK（回應內容依端點而定）」
    expect(Object.values(responses).some((r) => r.description?.startsWith('OK（回應內容依端點而定）'))).toBe(false);
    expect(Object.keys(responses).length).toBeGreaterThan(0);
    const successes = Object.entries(responses).filter(([c]) => c.startsWith('2') || c === '302');
    expect(successes.length).toBeGreaterThan(0);
    for (const [, r] of successes) expect(r.content !== undefined || typeof r.description === 'string').toBe(true);
    if (body) expect(op!.requestBody, '寫入類路由缺 requestBody').toBeDefined();
    else expect(op!.requestBody).toBeUndefined();
    if (auth === 'required') expect(op!.security).toEqual([{ bearerAuth: [] }]);
    else expect(op!.security).toBeUndefined();
  });
});

describe('POST /api/oauth/signup', () => {
  const R = 'POST /api/oauth/signup';
  const good = (email: string) => ({ email, password: 'correct-horse-9', privacyConsent: true });

  it('201：成功回應符合 schema，且不含任何 session／token 欄位', async () => {
    const res = await post('/api/oauth/signup', { ...good(`sgc-signup-ok-${++seq}@test.com`), displayName: 'Tester' });
    const body = (await check(R, res, 201, S.Signup_SignupResult)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'invitationError', 'joinedTrip', 'ok', 'requiresVerification', 'userId']);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('201：帶 invitationToken 且邀請有效 → joinedTrip 有值、invitationError 為 null', async () => {
    const t = await seedTrip(db, { id: `sgc-inv-trip-${++seq}`, owner: ownerEmail, days: 1 });
    tripIds.push(t.id);
    const email = `sgc-signup-inv-${++seq}@test.com`;
    await seedInvitation(db, { tripId: t.id, token: `sgc-inv-${seq}`, invitedEmail: email, invitedBy: ownerEmail, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const res = await post('/api/oauth/signup', { ...good(email), displayName: 'Invitee', invitationToken: `sgc-inv-${seq}` });
    const body = (await check(R, res, 201, S.Signup_SignupResult)) as { joinedTrip: { id: string; title: string } | null; invitationError: string | null };
    expect(body.joinedTrip?.id).toBe(t.id);
    expect(typeof body.joinedTrip?.title).toBe('string');
    expect(body.invitationError).toBeNull();
  });

  it('201：邀請無效 → joinedTrip 為 null、invitationError 有值（字串）', async () => {
    const res = await post('/api/oauth/signup', { ...good(`sgc-signup-badinv-${++seq}@test.com`), invitationToken: 'bogus' });
    const body = (await check(R, res, 201, S.Signup_SignupResult)) as { joinedTrip: unknown; invitationError: string | null };
    expect(body.joinedTrip).toBeNull();
    expect(body.invitationError).toBe('INVITATION_INVALID');
  });

  it('400：密碼太短（文件 body schema 同樣判定不合法）', async () => {
    const res = await postBad('/api/oauth/signup', { ...good(`sgc-signup-sp-${++seq}@test.com`), password: 'short' });
    expect(((await check(R, res, 400, ApiError)) as { error: { code: string } }).error.code).toBe('SIGNUP_PASSWORD_TOO_SHORT');
  });

  it('400：未同意個資條款', async () => {
    const res = await postBad('/api/oauth/signup', { email: `sgc-signup-nc-${++seq}@test.com`, password: 'correct-horse-9' });
    const body = (await check(R, res, 400, ApiError)) as { error: { code: string } };
    expect(body.error.code).toBe('SIGNUP_CONSENT_REQUIRED');
  });

  it('409：email 已註冊（與新 email 的 201 可區分——signup 沒有防列舉設計，文件如實記錄）', async () => {
    const email = `sgc-signup-dup-${++seq}@test.com`;
    expect((await post('/api/oauth/signup', good(email))).status).toBe(201);
    const res = await post('/api/oauth/signup', good(email));
    const body = (await check(R, res, 409, ApiError)) as { error: { code: string } };
    expect(body.error.code).toBe('SIGNUP_EMAIL_TAKEN');
  });

  it('429：per-IP 額度用盡', async () => {
    const ip = freshIp();
    await lock(`signup:${ip}`);
    const res = await post('/api/oauth/signup', good(`sgc-signup-rl-${++seq}@test.com`), ip);
    const body = (await check(R, res, 429, ApiError)) as { error: { code: string } };
    expect(body.error.code).toBe('SIGNUP_RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('send-verification / forgot-password：回應與帳號狀態無關（防帳號列舉）', () => {
  async function responsesFor(path: string, rateKey: string, route: string) {
    const unverifiedLocal = await seedAccount('enum-unv');
    const verifiedLocal = await seedAccount('enum-ver', { verified: true });
    const googleOnly = await seedAccount('enum-goog', { provider: 'google' });
    const emails = [unverifiedLocal.email, verifiedLocal.email, googleOnly.email, `sgc-enum-none-${++seq}@test.com`];
    const out: Array<{ status: number; body: unknown }> = [];
    for (const email of emails) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const res = await post(path, { email });
      const body = await check(route, res, 200, S.Signup_GenericMessage);
      out.push({ status: res.status, body });
    }
    void rateKey;
    return out;
  }

  it('forgot-password：已註冊（本地）／已驗證／Google-only／不存在的 email，狀態碼與 body 完全相同', async () => {
    const out = await responsesFor('/api/oauth/forgot-password', 'forgot-password', 'POST /api/oauth/forgot-password');
    for (const o of out) expect(o).toEqual(out[0]);
  });

  it('send-verification：未驗證／已驗證／Google-only／不存在的 email，狀態碼與 body 完全相同', async () => {
    const out = await responsesFor('/api/oauth/send-verification', 'send-verification', 'POST /api/oauth/send-verification');
    for (const o of out) expect(o).toEqual(out[0]);
  });

  it('forgot-password 缺 email 也回同樣形狀', async () => {
    const res = await post('/api/oauth/forgot-password', {});
    await check('POST /api/oauth/forgot-password', res, 200, S.Signup_GenericMessage);
  });

  it('forgot-password 429', async () => {
    const ip = freshIp();
    await lock(`forgot-password:${ip}`);
    const res = await post('/api/oauth/forgot-password', { email: `sgc-fp-rl-${++seq}@test.com` }, ip);
    const body = (await check('POST /api/oauth/forgot-password', res, 429, ApiError)) as { error: { code: string } };
    expect(body.error.code).toBe('FORGOT_PASSWORD_RATE_LIMITED');
  });

  it('send-verification 429', async () => {
    const ip = freshIp();
    await lock(`send-verification:${ip}`);
    const res = await post('/api/oauth/send-verification', { email: `sgc-sv-rl-${++seq}@test.com` }, ip);
    const body = (await check('POST /api/oauth/send-verification', res, 429, ApiError)) as { error: { code: string } };
    expect(body.error.code).toBe('VERIFY_RATE_LIMITED');
  });
});

describe('verify', () => {
  async function seedToken(): Promise<{ token: string; id: string }> {
    const u = await seedAccount('verify');
    const token = `sgc-vt-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'EmailVerification').upsert(token, { userId: u.id, email: u.email, createdAt: Date.now() }, 3600);
    return { token, id: u.id };
  }

  it('POST 200 → 再用同一 token 400 used；未知 token 400 expired；缺 token 400 missing_token', async () => {
    const { token } = await seedToken();
    const R = 'POST /api/oauth/verify';
    await check(R, await post('/api/oauth/verify', { token }), 200, S.Signup_OkOnly);
    expect(((await check(R, await post('/api/oauth/verify', { token }), 400, S.Signup_VerifyError)) as { error: string }).error).toBe('used');
    expect(((await check(R, await post('/api/oauth/verify', { token: 'sgc-nope' }), 400, S.Signup_VerifyError)) as { error: string }).error).toBe('expired');
    expect(((await check(R, await postBad('/api/oauth/verify', {}), 400, S.Signup_VerifyError)) as { error: string }).error).toBe('missing_token');
  });

  it('GET 302 導向 /login（舊連結）', async () => {
    const { token } = await seedToken();
    const res = await api.get(`/api/oauth/verify?token=${token}`);
    await check('GET /api/oauth/verify', res, 302);
    expect(res.headers.get('Location')).toBe('/login?verified=1');
  });
});

describe('POST /api/oauth/reset-password', () => {
  const R = 'POST /api/oauth/reset-password';
  it('200 成功；400 缺 token（ApiError）；400 無效 token；429', async () => {
    const u = await seedAccount('reset');
    const token = `sgc-rt-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'PasswordReset').upsert(token, { userId: u.id, email: u.email, createdAt: Date.now(), used: false }, 3600);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await check(R, await post('/api/oauth/reset-password', { token, password: 'brand-new-pass-1' }), 200, S.Signup_GenericMessage);
    expect(((await check(R, await postBad('/api/oauth/reset-password', { password: 'brand-new-pass-1' }), 400, ApiError)) as { error: { code: string } }).error.code).toBe('RESET_TOKEN_MISSING');
    expect(((await check(R, await post('/api/oauth/reset-password', { token: 'sgc-bad', password: 'brand-new-pass-1' }), 400, ApiError)) as { error: { code: string } }).error.code).toBe('RESET_TOKEN_INVALID');
    const ip = freshIp();
    await lock(`reset-password:${ip}`);
    expect(((await check(R, await post('/api/oauth/reset-password', { token, password: 'brand-new-pass-1' }, ip), 429, ApiError)) as { error: { code: string } }).error.code).toBe('RESET_RATE_LIMITED');
  });
});

describe('分享', () => {
  let tripId: string;
  beforeAll(async () => {
    const t = await seedTrip(db, { id: 'sgc-share-trip', owner: ownerEmail, days: 2 });
    tripId = t.id;
    tripIds.push(tripId);
    await db.prepare("INSERT INTO trip_flights (trip_id, airline, flight_no) VALUES (?, 'BR', '112')").bind(tripId).run();
    await db.prepare("INSERT INTO trip_destinations (trip_id, name, dest_order) VALUES (?, 'Naha', 0)").bind(tripId).run();
  });

  it('POST /shares 200（不是 201）、GET 列表、PATCH 三種 action、DELETE', async () => {
    const base = `/api/trips/${tripId}/shares`;
    const created = await api.request('POST', base, { as: ownerEmail, json: sent(S.Signup_ShareCreateBody, { label: 'L', visibleSections: ['flights'], anonymous: true, expiresAt: Date.now() + 86_400_000 }) });
    const c = (await check('POST /api/trips/:id/shares', created, 200, S.Signup_ShareCreated)) as { id: number; visibleSections: string[] };
    expect(c.visibleSections).toEqual(['flights']);
    // 對照：未知 section 文件判定不合法，handler 也實際濾掉（不報錯）
    const bogusBody = { visibleSections: ['flights', 'bogus'] };
    expect(contractIssues(S.Signup_ShareCreateBody, bogusBody).length).toBeGreaterThan(0);
    const filtered = await api.request('POST', base, { as: ownerEmail, json: bogusBody });
    expect(((await check('POST /api/trips/:id/shares', filtered, 200, S.Signup_ShareCreated)) as { visibleSections: string[] }).visibleSections).toEqual(['flights']);
    const defaults = await api.request('POST', base, { as: ownerEmail, json: sent(S.Signup_ShareCreateBody, {}) });
    await check('POST /api/trips/:id/shares', defaults, 200, S.Signup_ShareCreated);

    const list = await api.get(base, { as: ownerEmail });
    const l = (await check('GET /api/trips/:id/shares', list, 200, S.Signup_ShareList)) as { shares: unknown[] };
    expect(l.shares.length).toBeGreaterThanOrEqual(2);

    const P = 'PATCH /api/trips/:id/shares/:shareId';
    const patch = (body: unknown, id = c.id, t = tripId, as = ownerEmail) => api.request('PATCH', `/api/trips/${t}/shares/${id}`, { as, json: body });
    const upd = (body: Record<string, unknown>) => patch(sent(S.Signup_SharePatchBody, body));
    await check(P, await upd({ action: 'update', label: 'x', visibleSections: ['lodgings'], anonymous: false, expiresAt: null }), 200, S.Signup_SharePatchResult);
    await check(P, await upd({ action: 'rotate' }), 200, S.Signup_SharePatchResult);
    expect(contractIssues(S.Signup_SharePatchBody, { action: 'bogus' }).length).toBeGreaterThan(0); // 對照：文件也判定不合法
    expect(((await check(P, await patch({ action: 'bogus' }), 400, ApiError)) as { error: { code: string } }).error.code).toBe('DATA_VALIDATION');
    await check(P, await upd({ action: 'update' }), 400, ApiError); // schema 合法但 handler 拒絕（沒有可更新欄位）
    await check(P, await upd({ action: 'revoke' }), 200, S.Signup_SharePatchResult);
    expect(((await check(P, await upd({ action: 'revoke' }), 404, ApiError)) as { error: { code: string } }).error.code).toBe('DATA_NOT_FOUND');
    await check(P, await upd({ action: 'rotate' }), 404, ApiError);
    // 已撤銷的連結仍在列表中，revokedAt 有值（字串）
    const afterRevoke = (await check('GET /api/trips/:id/shares', await api.get(base, { as: ownerEmail }), 200, S.Signup_ShareList)) as { shares: Array<{ id: number; revokedAt: string | null }> };
    expect(typeof afterRevoke.shares.find((x) => x.id === c.id)?.revokedAt).toBe('string');

    const D = 'DELETE /api/trips/:id/shares/:shareId';
    const del = (id: number, as = ownerEmail) => api.request('DELETE', `/api/trips/${tripId}/shares/${id}`, { as });
    await check(D, await del(c.id), 200, S.Signup_ShareDeleted);
    await check(D, await del(c.id), 404, ApiError);
  });

  it('401（沒帶 token）與 403（沒有寫入權限）', async () => {
    const s = await seedShare(tripId);
    const cases: Array<[string, string, string, unknown]> = [
      ['GET /api/trips/:id/shares', 'GET', `/api/trips/${tripId}/shares`, undefined],
      ['POST /api/trips/:id/shares', 'POST', `/api/trips/${tripId}/shares`, {}],
      ['PATCH /api/trips/:id/shares/:shareId', 'PATCH', `/api/trips/${tripId}/shares/${s.id}`, { action: 'revoke' }],
      ['DELETE /api/trips/:id/shares/:shareId', 'DELETE', `/api/trips/${tripId}/shares/${s.id}`, undefined],
    ];
    for (const [route, method, path, json] of cases) {
      const anon = await api.request(method, path, { json });
      expect(((await check(route, anon, 401, ApiError)) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
      const forbidden = await api.request(method, path, { as: viewerEmail, json });
      expect(((await check(route, forbidden, 403, ApiError)) as { error: { code: string } }).error.code).toBe('PERM_DENIED');
    }
  });

  it('GET /api/share/:token 200（公開，含 days／notes）；未知 token 404；429', async () => {
    const R = 'GET /api/share/:token';
    const s = await seedShare(tripId, { visibleSections: ['flights'] });
    const ip = freshIp();
    const ok = await api.get(`/api/share/${s.token}`, { headers: { 'CF-Connecting-IP': ip } });
    const body = (await check(R, ok, 200, S.Signup_SharePayload)) as { days: unknown[]; notes: { flights: unknown[] }; meta: { destinations: unknown[] } };
    expect(body.days.length).toBe(2);
    expect(body.notes.flights.length).toBe(1);
    expect(body.meta.destinations).toEqual([{ name: 'Naha' }]);

    const nf = await api.get('/api/share/not-a-real-token-xxxxxxxxxxxxxxxx', { headers: { 'CF-Connecting-IP': ip } });
    expect(((await check(R, nf, 404, S.Signup_ShareFlatError)) as { error: string }).error).toBe('NOT_FOUND');

    const rlIp = freshIp();
    await lock(`share-view:${rlIp}`);
    const rl = await api.get(`/api/share/${s.token}`, { headers: { 'CF-Connecting-IP': rlIp } });
    expect(((await check(R, rl, 429, S.Signup_ShareFlatError)) as { error: string }).error).toBe('RATE_LIMIT');
  });

  it('POST /api/share/:token/clone 201；401；404；429', async () => {
    const R = 'POST /api/share/:token/clone';
    const s = await seedShare(tripId);
    const ip = freshIp();
    const cloner = `sgc-cloner-${++seq}@test.com`;
    const ok = await api.request('POST', `/api/share/${s.token}/clone`, { as: cloner, headers: { 'CF-Connecting-IP': ip } });
    const body = (await check(R, ok, 201, S.Signup_CloneResult)) as { daysCreated: number };
    expect(body.daysCreated).toBe(2);

    const anon = await api.request('POST', `/api/share/${s.token}/clone`, { headers: { 'CF-Connecting-IP': ip } });
    expect(((await check(R, anon, 401, ApiError)) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');

    const nf = await api.request('POST', '/api/share/not-a-real-token-xxxxxxxxxxxxxxxx/clone', { as: cloner, headers: { 'CF-Connecting-IP': ip } });
    expect(((await check(R, nf, 404, S.Signup_ShareFlatError)) as { error: string }).error).toBe('NOT_FOUND');

    const rlIp = freshIp();
    await lock(`clone:ip:${rlIp}`);
    const rl = await api.request('POST', `/api/share/${s.token}/clone`, { as: cloner, headers: { 'CF-Connecting-IP': rlIp } });
    expect(((await check(R, rl, 429, S.Signup_ShareFlatError)) as { error: string }).error).toBe('RATE_LIMIT');
  });
});

describe('文件列出的狀態碼都有被實際觸發', () => {
  it.each(ROUTES)('$method $path', ({ method, path }) => {
    const op = doc.paths[openapiPath(path)]![method]!;
    const missing = Object.keys(op.responses).filter((code) => !hits.has(`${method.toUpperCase()} ${path} ${code}`));
    expect(missing, `文件列了但測試沒觸發：${missing.join(',')}`).toEqual([]);
  });
});
