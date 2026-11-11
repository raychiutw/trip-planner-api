/**
 * passkey 重新驗證／step-up 發證（spec web#1677、票 api#81）：
 *   POST /api/account/reauth/options   發出 step-up 專用挑戰（綁定本人與目前 grant）
 *   POST /api/account/reauth/passkey   用 assertion 換 step-up 證明
 *   POST /api/account/reauth/password  沒有 passkey 的人用目前密碼換 step-up 證明
 * 另測共用驗證函式 verifyStepUpProof（#82 的敏感端點會呼叫；本票不掛在任何端點上）。
 *
 * 走 HTTP 邊界：真實 bearer → middleware → handler。authenticator 由本檔用 WebCrypto 現場產生拋棄式金鑰。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor, type TestSession } from './account-session-helper';
import { hashPassword } from '../../src/lib/password';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { STEP_UP_PROOF_HEADER, verifyStepUpProof } from '../../src/lib/step-up';
import type { AccountUser } from '../../src/lib/account-user';
import type { Env } from '../../src/env';

const PREFIX = 'stepup';
const RP_ID = 'trip-planner-dby.pages.dev';
const ORIGIN = `https://${RP_ID}`;
const PASSWORD = 'correct-horse-battery';

let db: D1Database;
let env: Env;
let api: Api;
let seq = 0;
const userIds: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  env = mockEnv(db);
  api = createApi({ env });
}, 30_000);

afterAll(async () => {
  for (const id of userIds) {
    await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM oauth_models WHERE json_extract(payload, \'$.user_id\') = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%${id}%`).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

type User = TestSession & { email: string };
async function seed(opts: { password?: string | null } = {}): Promise<User> {
  const id = `${PREFIX}-u${++seq}`;
  const email = `${id}@example.com`;
  userIds.push(id);
  const s = await sessionFor(db, email, id);
  const password = opts.password === undefined ? null : opts.password;
  if (password) {
    await db.prepare(`INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES (?, 'local', ?, ?, 'pbkdf2')`)
      .bind(id, email, await hashPassword(password)).run();
  } else {
    await db.prepare(`INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES (?, 'google', ?)`).bind(id, `g-${id}`).run();
  }
  return { ...s, email };
}
/** 同一個使用者的另一個登入（不同 grant）。 */
const otherSession = (u: User) => sessionFor(db, u.email, u.userId);

// ───────── 假的 authenticator ─────────

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const head = (major: number, n: number) => (n < 24 ? Uint8Array.of((major << 5) | n) : Uint8Array.of((major << 5) | 24, n));
type Cbor = number | Uint8Array | Map<number, Cbor>;
function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}
function toDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    const body = v[0]! & 0x80 ? cat(Uint8Array.of(0), v) : v;
    return cat(Uint8Array.of(2, body.length), body);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}
interface Authenticator { credId: string; sign: (data: Uint8Array) => Promise<Uint8Array>; cose: string }
async function newAuthenticator(): Promise<Authenticator> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const cose = cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]]));
  return {
    credId: b64u(crypto.getRandomValues(new Uint8Array(32))),
    cose: b64u(cose),
    sign: async (data) => toDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data))),
  };
}
async function addKey(userId: string, signCount = 0): Promise<Authenticator> {
  const a = await newAuthenticator();
  await db.prepare("INSERT INTO passkey_credentials (id, user_id, public_key, alg, sign_count, name) VALUES (?, ?, ?, -7, ?, 'test')")
    .bind(a.credId, userId, a.cose, signCount).run();
  return a;
}
const signCountOf = async (id: string) => (await db.prepare('SELECT sign_count FROM passkey_credentials WHERE id = ?').bind(id).first<{ sign_count: number }>())!.sign_count;

interface AssertOpts { rpId?: string; flags?: number; signCount?: number; origin?: string; badSignature?: boolean }
async function assertion(a: Authenticator, challenge: string, o: AssertOpts = {}) {
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(o.rpId ?? RP_ID)));
  const sc = new Uint8Array(4);
  new DataView(sc.buffer).setUint32(0, o.signCount ?? 1);
  const authData = cat(rpHash, Uint8Array.of(o.flags ?? 0x05), sc); // UP 0x01、UV 0x04
  const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signature = await a.sign(cat(authData, hash));
  if (o.badSignature) signature[signature.length - 1]! ^= 0xff;
  return { id: a.credId, type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) } };
}

// ───────── HTTP ─────────

const options = (bearer?: string) => api.request('POST', '/api/account/reauth/options', { bearer, json: {} });
const viaPasskey = (bearer: string | undefined, credential: unknown) => api.request('POST', '/api/account/reauth/passkey', { bearer, json: { credential } });
const viaPassword = (bearer: string | undefined, password: unknown) => api.request('POST', '/api/account/reauth/password', { bearer, json: { password } });
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const challengeFor = async (bearer: string) => {
  const res = await options(bearer);
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
};
/** 取挑戰 → 簽 assertion → 換證明。 */
async function stepUp(u: User, a: Authenticator, o: AssertOpts = {}, bearer = u.bearer) {
  return viaPasskey(bearer, await assertion(a, await challengeFor(u.bearer), o));
}
const proofOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return ((await res.json()) as { proof: string }).proof;
};
const proofRows = async (userId: string) =>
  (await db.prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'StepUpProof' AND json_extract(payload, '$.user_id') = ?").bind(userId).all<{ id: string; payload: string; expires_at: number }>()).results;
const audit = async (userId: string, type = 'reauth') =>
  (await db.prepare('SELECT outcome, failure_reason, metadata FROM auth_audit_log WHERE user_id = ? AND event_type = ? ORDER BY id').bind(userId, type).all<{ outcome: string; failure_reason: string | null; metadata: string | null }>()).results;

function accountUser(u: User, grantId: string | null = u.grantId): AccountUser {
  return { uid: u.userId, email: u.email, auth: { email: u.email, userId: u.userId, isServiceToken: false, grantId: grantId ?? undefined } };
}
const withProof = (proof: string | null) =>
  ({ request: new Request('https://test.com/x', { headers: proof === null ? {} : { [STEP_UP_PROOF_HEADER]: proof } }), env });

describe('POST /api/account/reauth/options', () => {
  it('401 未登入', async () => {
    expect((await options()).status).toBe(401);
  });

  it('回 step-up 選項：RP ID、必須做使用者驗證、allowCredentials 只含本人的憑證、每次挑戰不同、no-store', async () => {
    const u = await seed();
    const mine = await addKey(u.userId);
    await addKey((await seed()).userId);
    const res = await options(u.bearer);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const o = (await res.json()) as any;
    expect(o.rpId).toBe(RP_ID);
    expect(o.userVerification).toBe('required');
    expect(o.allowCredentials.map((c: any) => c.id)).toEqual([mine.credId]);
    expect(Buffer.from(o.challenge, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(await challengeFor(u.bearer)).not.toBe(o.challenge);
  });

  it('挑戰存進 oauth_models：用途 passkey-stepup、綁本人與目前 grant、約 5 分鐘到期', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const r = (await db.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'PasskeyChallenge' AND id = ?").bind(ch).first<{ payload: string; expires_at: number }>())!;
    expect(JSON.parse(r.payload)).toMatchObject({ purpose: 'passkey-stepup', user_id: u.userId, grant_id: u.grantId });
    expect(Math.abs(r.expires_at - (Date.now() + 5 * 60_000))).toBeLessThan(3000);
  });

  it('沒有 grantId 的舊格式 token 無法綁定 session：401', async () => {
    const u = await seed();
    const token = `nogrant-${crypto.randomUUID()}`;
    await new D1Adapter(db, 'AccessToken').upsert(token, { client_id: 'tripline-web', user_id: u.userId, scopes: ['openid'] }, 300);
    expect((await options(token)).status).toBe(401);
  });
});

describe('POST /api/account/reauth/passkey', () => {
  it('401 未登入', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    expect((await viaPasskey(undefined, await assertion(a, await challengeFor(u.bearer)))).status).toBe(401);
  });

  it('成功：回 proof 與 expires_in=300（no-store）；DB 存 StepUpProof（本人、目前 grant、約 5 分鐘）；更新簽名計數；寫 audit', async () => {
    const u = await seed();
    const a = await addKey(u.userId, 3);
    const res = await stepUp(u, a, { signCount: 4 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'proof']);
    expect(body.expires_in).toBe(300);
    const [row] = await proofRows(u.userId);
    expect(row!.id).toBe(body.proof);
    expect(JSON.parse(row!.payload)).toMatchObject({ user_id: u.userId, grant_id: u.grantId, method: 'passkey' });
    expect(Math.abs(row!.expires_at - (Date.now() + 5 * 60_000))).toBeLessThan(3000);
    expect(await signCountOf(a.credId)).toBe(4);
    expect(await audit(u.userId)).toEqual([expect.objectContaining({ outcome: 'success', failure_reason: null })]);
    expect(await verifyStepUpProof(withProof(body.proof as string), accountUser(u))).toBe(true);
  });

  it('簽名計數都是 0（同步型 passkey）可以換證明', async () => {
    const u = await seed();
    const a = await addKey(u.userId, 0);
    expect((await stepUp(u, a, { signCount: 0 })).status).toBe(200);
    expect((await stepUp(u, a, { signCount: 0 })).status).toBe(200);
  });

  async function expectRejected(u: User, res: Response, reason?: string) {
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('REAUTH_INVALID');
    expect(await proofRows(u.userId)).toHaveLength(0);
    if (reason) expect(await audit(u.userId)).toEqual([expect.objectContaining({ outcome: 'failure', failure_reason: reason })]);
  }

  it('他人的 passkey 不能換證明（憑證不屬於目前登入的使用者）', async () => {
    const u = await seed();
    const other = await seed();
    const theirs = await addKey(other.userId);
    await expectRejected(u, await stepUp(u, theirs), 'passkey_unknown_credential');
    expect(await proofRows(other.userId)).toHaveLength(0);
  });

  it('不存在的憑證被拒，回應與其他失敗一致', async () => {
    const u = await seed();
    await expectRejected(u, await stepUp(u, await newAuthenticator()), 'passkey_unknown_credential');
  });

  it('缺使用者驗證（UV）被拒', async () => {
    const u = await seed();
    await expectRejected(u, await stepUp(u, await addKey(u.userId), { flags: 0x01 }), 'passkey_uv_required');
  });

  it('簽名錯、RP ID 不符、來源不符一律被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    await expectRejected(u, await stepUp(u, a, { badSignature: true }));
    expect((await stepUp(u, a, { rpId: 'evil.example' })).status).toBe(403);
    expect((await stepUp(u, a, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await proofRows(u.userId)).toHaveLength(0);
  });

  it('簽名計數倒退被拒（疑似複製的憑證），記 signature_error 安全事件，計數不變', async () => {
    const u = await seed();
    const a = await addKey(u.userId, 10);
    await expectRejected(u, await stepUp(u, a, { signCount: 10 }), 'passkey_sign_count_regression');
    expect(await signCountOf(a.credId)).toBe(10);
    expect(await audit(u.userId, 'signature_error')).toEqual([expect.objectContaining({ failure_reason: 'stepup_sign_count_regression' })]);
  });

  it('挑戰只能用一次：重放被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await challengeFor(u.bearer);
    expect((await viaPasskey(u.bearer, await assertion(a, ch, { signCount: 1 }))).status).toBe(200);
    expect((await viaPasskey(u.bearer, await assertion(a, ch, { signCount: 2 }))).status).toBe(403);
  });

  it('挑戰逾期被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await challengeFor(u.bearer);
    await db.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'PasskeyChallenge' AND id = ?").bind(Date.now() - 1000, ch).run();
    await expectRejected(u, await viaPasskey(u.bearer, await assertion(a, ch)), 'passkey_challenge_invalid');
  });

  it('挑戰用途不可混用：登入挑戰不能拿來做 step-up', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const loginCh = ((await (await api.request('POST', '/api/oauth/passkey/options', { json: {} })).json()) as { challenge: string }).challenge;
    await expectRejected(u, await viaPasskey(u.bearer, await assertion(a, loginCh)), 'passkey_challenge_invalid');
  });

  it('挑戰用途不可混用：註冊挑戰不能拿來做 step-up', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const regCh = ((await (await api.request('POST', '/api/account/passkeys/register/options', { bearer: u.bearer, json: {} })).json()) as { challenge: string }).challenge;
    await expectRejected(u, await viaPasskey(u.bearer, await assertion(a, regCh)));
  });

  it('挑戰用途不可混用：step-up 挑戰不能拿來登入', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await challengeFor(u.bearer);
    const res = await api.request('POST', '/api/oauth/passkey/login', {
      json: { client_id: 'tripline-web', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', credential: await assertion(a, ch) },
    });
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('PASSKEY_LOGIN_INVALID');
    expect((await db.prepare("SELECT COUNT(*) AS n FROM oauth_models WHERE name = 'AuthorizationCode' AND json_extract(payload, '$.user_id') = ?").bind(u.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it('挑戰綁使用者：A 的挑戰不能由 B 用自己的 passkey 完成', async () => {
    const a = await seed();
    const b = await seed();
    const bKey = await addKey(b.userId);
    const chA = await challengeFor(a.bearer);
    const res = await viaPasskey(b.bearer, await assertion(bKey, chA));
    expect(res.status).toBe(403);
    expect(await proofRows(b.userId)).toHaveLength(0);
  });

  it('挑戰綁 session：同一個使用者的另一個登入拿不到這個挑戰換證明', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const second = await otherSession(u);
    const ch = await challengeFor(u.bearer);
    const res = await viaPasskey(second.bearer, await assertion(a, ch));
    expect(res.status).toBe(403);
    expect(await proofRows(u.userId)).toHaveLength(0);
  });

  // 各欄位單獨檢查：user_id、grant_id、purpose 各自都必須對上（不能只靠其中一個擋住）
  async function forgedChallenge(over: Record<string, unknown>) {
    const ch = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await new D1Adapter(db, 'PasskeyChallenge').upsert(ch, { purpose: 'passkey-stepup', ...over }, 300);
    return ch;
  }
  it('挑戰的 purpose 錯（其餘欄位都對）被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await forgedChallenge({ user_id: u.userId, grant_id: u.grantId, purpose: 'passkey-register' });
    expect((await viaPasskey(u.bearer, await assertion(a, ch))).status).toBe(403);
  });
  it('挑戰的 user_id 錯（grant 與 purpose 都對）被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await forgedChallenge({ user_id: (await seed()).userId, grant_id: u.grantId });
    expect((await viaPasskey(u.bearer, await assertion(a, ch))).status).toBe(403);
  });
  it('挑戰的 grant_id 錯（user 與 purpose 都對）被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await forgedChallenge({ user_id: u.userId, grant_id: 'someone-elses-grant' });
    expect((await viaPasskey(u.bearer, await assertion(a, ch))).status).toBe(403);
  });
  it('以上欄位全對的挑戰是可用的（對照組，確認上面幾個測試真的是因為單一欄位而被拒）', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const ch = await forgedChallenge({ user_id: u.userId, grant_id: u.grantId });
    expect((await viaPasskey(u.bearer, await assertion(a, ch))).status).toBe(200);
  });

  it('缺欄位或 body 不合法：403 REAUTH_INVALID，不是 500', async () => {
    const u = await seed();
    expect((await viaPasskey(u.bearer, { id: 'x' })).status).toBe(403);
    expect((await api.request('POST', '/api/account/reauth/passkey', { bearer: u.bearer, json: [] })).status).toBe(403);
  });

  it('失敗計入限流：連續失敗後連正確的 assertion 也回 429', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await stepUp(u, a, { badSignature: true })).status);
    expect(codes).toEqual([403, 403, 403, 403, 403, 429]);
    const res = await stepUp(u, a);
    expect(res.status).toBe(429);
    expect(await errCode(res)).toBe('REAUTH_RATE_LIMITED');
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /api/account/reauth/password', () => {
  it('401 未登入', async () => {
    expect((await viaPassword(undefined, PASSWORD)).status).toBe(401);
  });

  it('成功：回 proof 與 expires_in=300；DB 存 StepUpProof（本人、目前 grant）；寫 audit；密碼不進任何紀錄', async () => {
    const u = await seed({ password: PASSWORD });
    const res = await viaPassword(u.bearer, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { proof: string; expires_in: number };
    expect(body.expires_in).toBe(300);
    const [row] = await proofRows(u.userId);
    expect(row!.id).toBe(body.proof);
    expect(JSON.parse(row!.payload)).toMatchObject({ user_id: u.userId, grant_id: u.grantId, method: 'password' });
    const log = await audit(u.userId);
    expect(log).toEqual([expect.objectContaining({ outcome: 'success' })]);
    expect(JSON.stringify(log)).not.toContain(PASSWORD);
    expect(await verifyStepUpProof(withProof(body.proof), accountUser(u))).toBe(true);
  });

  it('錯密碼、沒帶密碼被拒（403，不用 401），計入限流；不發證明', async () => {
    const u = await seed({ password: PASSWORD });
    for (const bad of ['wrong-password-1', '', undefined, 123]) {
      const res = await viaPassword(u.bearer, bad);
      expect(res.status).toBe(403);
      expect(await errCode(res)).toBe('REAUTH_INVALID');
    }
    expect(await proofRows(u.userId)).toHaveLength(0);
    expect((await audit(u.userId)).map((r) => r.failure_reason)).toEqual(['password_invalid', 'password_invalid', 'password_invalid', 'password_invalid']);
  });

  it('連續錯密碼：第 6 次起回 429，之後連正確密碼也被擋', async () => {
    const u = await seed({ password: PASSWORD });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await viaPassword(u.bearer, `wrong-${i}`)).status);
    expect(codes).toEqual([403, 403, 403, 403, 403, 429]);
    const res = await viaPassword(u.bearer, PASSWORD);
    expect(res.status).toBe(429);
    expect(await errCode(res)).toBe('REAUTH_RATE_LIMITED');
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await proofRows(u.userId)).toHaveLength(0);
  });

  it('錯密碼與 passkey 失敗共用同一個鎖：鎖住後 passkey 路徑也回 429', async () => {
    const u = await seed({ password: PASSWORD });
    const a = await addKey(u.userId);
    for (let i = 0; i < 6; i++) await viaPassword(u.bearer, `wrong-${i}`);
    expect((await stepUp(u, a)).status).toBe(429);
  });

  it('限流以使用者為單位：A 被鎖不影響 B', async () => {
    const a = await seed({ password: PASSWORD });
    const b = await seed({ password: PASSWORD });
    for (let i = 0; i < 6; i++) await viaPassword(a.bearer, `wrong-${i}`);
    expect((await viaPassword(b.bearer, PASSWORD)).status).toBe(200);
  });

  it('成功後失敗計數清零', async () => {
    const u = await seed({ password: PASSWORD });
    for (let i = 0; i < 4; i++) await viaPassword(u.bearer, `wrong-${i}`);
    expect((await viaPassword(u.bearer, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await viaPassword(u.bearer, `wrong-${i}`)).status).toBe(403);
  });

  it('沒有密碼的帳號（只有第三方登入）回 409 REAUTH_NO_PASSWORD，不能因此繞過', async () => {
    const u = await seed({ password: null });
    for (const pw of [PASSWORD, '', undefined]) {
      const res = await viaPassword(u.bearer, pw);
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe('REAUTH_NO_PASSWORD');
    }
    expect(await proofRows(u.userId)).toHaveLength(0);
  });

  it('不會拿別人的密碼雜湊來比：只查本人的 local 身分', async () => {
    const u = await seed({ password: null });
    await seed({ password: PASSWORD });
    expect((await viaPassword(u.bearer, PASSWORD)).status).toBe(409);
  });
});

describe('verifyStepUpProof（共用驗證函式）', () => {
  async function issue(u: User) {
    return proofOf(await viaPassword(u.bearer, PASSWORD));
  }

  it('本人、同一個 session、未過期：true，且 5 分鐘內可重複使用', async () => {
    const u = await seed({ password: PASSWORD });
    const proof = await issue(u);
    expect(await verifyStepUpProof(withProof(proof), accountUser(u))).toBe(true);
    expect(await verifyStepUpProof(withProof(proof), accountUser(u))).toBe(true);
  });

  it('沒帶、亂填、空字串：false', async () => {
    const u = await seed({ password: PASSWORD });
    await issue(u);
    expect(await verifyStepUpProof(withProof(null), accountUser(u))).toBe(false);
    expect(await verifyStepUpProof(withProof('nope'), accountUser(u))).toBe(false);
    expect(await verifyStepUpProof(withProof(''), accountUser(u))).toBe(false);
  });

  it('過期：false', async () => {
    const u = await seed({ password: PASSWORD });
    const proof = await issue(u);
    await db.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'StepUpProof' AND id = ?").bind(Date.now() - 1000, proof).run();
    expect(await verifyStepUpProof(withProof(proof), accountUser(u))).toBe(false);
  });

  it('跨使用者：false（A 的證明拿給 B 用）', async () => {
    const a = await seed({ password: PASSWORD });
    const b = await seed({ password: PASSWORD });
    const proof = await issue(a);
    expect(await verifyStepUpProof(withProof(proof), accountUser(b))).toBe(false);
  });

  it('跨 session：false（同一個使用者的另一個登入不能用）', async () => {
    const u = await seed({ password: PASSWORD });
    const proof = await issue(u);
    const second = await otherSession(u);
    expect(await verifyStepUpProof(withProof(proof), accountUser(u, second.grantId))).toBe(false);
  });

  it('呼叫端沒有 grantId（無法確認 session）：false', async () => {
    const u = await seed({ password: PASSWORD });
    const proof = await issue(u);
    expect(await verifyStepUpProof(withProof(proof), accountUser(u, null))).toBe(false);
  });

  it('使用者與 session 各自獨立檢查：A 的 session 搭 B 的身分、B 的身分搭沒有 grantId 都 false', async () => {
    const a = await seed({ password: PASSWORD });
    const b = await seed({ password: PASSWORD });
    const proof = await issue(a);
    expect(await verifyStepUpProof(withProof(proof), accountUser(b, a.grantId))).toBe(false); // grant 對、user 錯
    expect(await verifyStepUpProof(withProof(proof), accountUser(a, b.grantId))).toBe(false); // user 對、grant 錯
  });

  it('證明資料列本身缺 grant_id 時，沒有 grantId 的呼叫端也不會因為兩邊都是空而通過', async () => {
    const u = await seed({ password: PASSWORD });
    await new D1Adapter(db, 'StepUpProof').upsert('forged-no-grant', { user_id: u.userId }, 300);
    expect(await verifyStepUpProof(withProof('forged-no-grant'), accountUser(u, null))).toBe(false);
  });

  it('只認 StepUpProof：拿 access token、step-up 挑戰當證明都是 false', async () => {
    const u = await seed({ password: PASSWORD });
    await issue(u);
    expect(await verifyStepUpProof(withProof(u.bearer), accountUser(u))).toBe(false);
    expect(await verifyStepUpProof(withProof(await challengeFor(u.bearer)), accountUser(u))).toBe(false);
  });

  it('端到端：passkey 換到的證明同樣被認可，且跨 session 被拒', async () => {
    const u = await seed();
    const a = await addKey(u.userId);
    const proof = await proofOf(await stepUp(u, a));
    expect(await verifyStepUpProof(withProof(proof), accountUser(u))).toBe(true);
    expect(await verifyStepUpProof(withProof(proof), accountUser(u, (await otherSession(u)).grantId))).toBe(false);
  });
});
