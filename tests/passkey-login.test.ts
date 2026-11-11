/**
 * passkey 登入（spec trip-planner#1677、票 api#79），未登入可呼叫：
 *   POST /api/oauth/passkey/options  發出一次性、短時效的登入挑戰
 *   POST /api/oauth/passkey/login    驗證 assertion，成功回 code（與 POST /api/oauth/login 同一條簽發路徑），之後走 token endpoint
 *
 * 走 HTTP 邊界、真 SQLite（全部 migrations）。authenticator 由本檔用 WebCrypto 現場產生拋棄式金鑰，不含任何真實金鑰。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { passkeyRp } from '../src/lib/passkey';
import { hashPassword } from '../src/lib/password';
import { createD1 } from './support/d1';
import { newKey, proof } from './support/dpop';

const RP_ID = 'trip-planner-dby.pages.dev';
const ORIGIN = `https://${RP_ID}`;
const VERIFIER = 'v'.repeat(64);
const PKCE = createHash('sha256').update(VERIFIER).digest('base64url');
const PASSWORD = 'correct-horse-battery';

let d1: ReturnType<typeof createD1>;
let env: Env;

beforeEach(() => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  addUser('u1', 'alice@example.com');
  addUser('u2', 'bob@example.com');
});
afterEach(() => d1.close());

function addUser(id: string, email: string, status = 'active') {
  d1.raw.prepare('INSERT INTO users (id, email, status) VALUES (?, ?, ?)').run(id, email, status);
}

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
/** WebCrypto 簽出的是 r||s，WebAuthn 傳的是 DER。 */
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
function seedCredential(userId: string, a: Authenticator, signCount = 0) {
  d1.raw.prepare("INSERT INTO passkey_credentials (id, user_id, public_key, alg, sign_count, name) VALUES (?, ?, ?, -7, ?, 'test')")
    .run(a.credId, userId, a.cose, signCount);
}
const row = (id: string) => d1.raw.prepare('SELECT sign_count, last_used_at FROM passkey_credentials WHERE id = ?').get(id) as { sign_count: number; last_used_at: string | null };

interface AssertOpts { rpId?: string; flags?: number; signCount?: number; origin?: string; type?: string; userHandle?: string | null; badSignature?: boolean }
async function assertion(a: Authenticator, challenge: string, o: AssertOpts = {}) {
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(o.rpId ?? RP_ID)));
  const sc = new Uint8Array(4);
  new DataView(sc.buffer).setUint32(0, o.signCount ?? 1);
  const authData = cat(rpHash, Uint8Array.of(o.flags ?? 0x05), sc); // UP 0x01、UV 0x04
  const clientDataJSON = enc.encode(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signature = await a.sign(cat(authData, hash));
  if (o.badSignature) signature[signature.length - 1]! ^= 0xff;
  return {
    id: a.credId, type: 'public-key',
    response: {
      clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature),
      ...(o.userHandle === null ? {} : { userHandle: o.userHandle ?? undefined }),
    },
  };
}
const handle = (uid: string) => b64u(enc.encode(uid));

// ───────── HTTP ─────────

const call = (path: string, body: unknown, ip = '1.1.1.1', e: Env = env) =>
  createApp().request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }, e);
const getChallenge = async (ip = '1.1.1.1', e: Env = env) => ((await (await call('/api/oauth/passkey/options', {}, ip, e)).json()) as { challenge: string }).challenge;
const grant = { client_id: 'tripline-web', code_challenge: PKCE, code_challenge_method: 'S256' };
const login = (credential: unknown, over: Record<string, unknown> = {}, ip = '1.1.1.1', e: Env = env) =>
  call('/api/oauth/passkey/login', { ...grant, credential, ...over }, ip, e);
/** 走完整流程：取挑戰 → 簽 assertion → 登入。 */
async function loginWith(a: Authenticator, o: AssertOpts = {}, over: Record<string, unknown> = {}, ip = '1.1.1.1', e: Env = env) {
  const ch = await getChallenge(ip, e);
  return login(await assertion(a, ch, o), over, ip, e);
}
const exchange = (c: string, dpop?: string) => {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' });
  if (dpop) headers.set('DPoP', dpop);
  return createApp().request('/api/oauth/token', { method: 'POST', headers, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'tripline-web', code: c, code_verifier: VERIFIER }).toString() }, env);
};
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;
const codeRows = () => d1.raw.prepare("SELECT payload FROM oauth_models WHERE name = 'AuthorizationCode'").all() as { payload: string }[];
const audit = (type: string) => d1.raw.prepare('SELECT outcome, user_id, failure_reason FROM auth_audit_log WHERE event_type = ? ORDER BY id').all(type) as { outcome: string; user_id: string | null; failure_reason: string | null }[];
type Err = { error: { code: string; message: string } };

async function seeded(signCount = 0) {
  const a = await newAuthenticator();
  seedCredential('u1', a, signCount);
  return a;
}
async function expectRejected(res: Response) {
  expect(res.status).toBe(401);
  expect(((await res.json()) as Err).error.code).toBe('PASSKEY_LOGIN_INVALID');
  expect(codeRows()).toHaveLength(0);
}

describe('POST /api/oauth/passkey/options', () => {
  it('不需登入；回登入選項：RP ID、必須做使用者驗證、allowCredentials 為空（不洩漏帳號）、每次挑戰不同', async () => {
    const res = await call('/api/oauth/passkey/options', {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const o = (await res.json()) as Record<string, any>;
    expect(o.rpId).toBe(RP_ID);
    expect(o.userVerification).toBe('required');
    expect(o.allowCredentials).toEqual([]);
    expect(Buffer.from(o.challenge, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(await getChallenge()).not.toBe(o.challenge);
  });
  it('挑戰存進 oauth_models 並有逾期時間（約 5 分鐘）', async () => {
    const ch = await getChallenge();
    const r = d1.raw.prepare("SELECT expires_at, payload FROM oauth_models WHERE name = 'PasskeyChallenge' AND id = ?").get(ch) as { expires_at: number; payload: string };
    expect(Math.abs(r.expires_at - (Date.now() + 5 * 60_000))).toBeLessThan(3000);
    expect(JSON.parse(r.payload)).toMatchObject({ purpose: 'passkey-login' });
  });
  it('有限流：同一個 IP 超過上限回 429', async () => {
    for (let i = 0; i < 50; i++) expect((await call('/api/oauth/passkey/options', {}, '5.5.5.5')).status).toBe(200);
    expect((await call('/api/oauth/passkey/options', {}, '5.5.5.5')).status).toBe(429);
  });
});

describe('登入成功', () => {
  it('回 code（no-store、無 cookie，只有 code 與 expires_in），更新 sign_count 與 last_used_at，寫 audit', async () => {
    const a = await seeded(3);
    const res = await loginWith(a, { signCount: 4 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'expires_in']);
    expect(body.expires_in).toBe(60);
    expect(row(a.credId).sign_count).toBe(4);
    expect(row(a.credId).last_used_at).toBeTruthy();
    expect(audit('login')).toEqual([{ outcome: 'success', user_id: 'u1', failure_reason: null }]);
  });
  it('code 的內容綁定本人、client、PKCE，沒有 redirect_uri，預設 scope', async () => {
    await loginWith(await seeded());
    expect(JSON.parse(codeRows()[0]!.payload)).toMatchObject({ client_id: 'tripline-web', user_id: 'u1', redirect_uri: null, scopes: ['openid', 'profile', 'email'], code_challenge: PKCE, code_challenge_method: 'S256' });
  });
  it('簽名計數都是 0（同步型 passkey 不回報計數）可以登入', async () => {
    const a = await seeded(0);
    expect((await loginWith(a, { signCount: 0 })).status).toBe(200);
    expect((await loginWith(a, { signCount: 0 })).status).toBe(200);
  });
  it('userHandle 與憑證屬主一致可以登入', async () => {
    expect((await loginWith(await seeded(), { userHandle: handle('u1') })).status).toBe(200);
  });
});

describe('token 與密碼登入同型（同一條簽發路徑）', () => {
  async function passwordLoginCode(over: Record<string, unknown> = {}) {
    d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES ('u1', 'local', 'alice@example.com', ?, 'pbkdf2')").run(await hashPassword(PASSWORD));
    const res = await call('/api/oauth/login', { email: 'alice@example.com', password: PASSWORD, ...grant, ...over });
    expect(res.status).toBe(200);
    return codeOf(res);
  }
  it('code 儲存的 payload 欄位與密碼登入完全一致', async () => {
    const a = await seeded();
    await loginWith(a);
    await passwordLoginCode();
    const [pk, pw] = codeRows().map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    expect(Object.keys(pk!).sort()).toEqual(Object.keys(pw!).sort());
    expect(pk).toEqual(pw);
  });
  it('端到端：兌換成 Bearer token，欄位與密碼登入的 token 回應相同', async () => {
    const a = await seeded();
    const pk = await exchange(await codeOf(await loginWith(a)));
    const pw = await exchange(await passwordLoginCode());
    expect(pk.status).toBe(200);
    const [bpk, bpw] = [(await pk.json()) as Record<string, unknown>, (await pw.json()) as Record<string, unknown>];
    expect(bpk).toMatchObject({ token_type: 'Bearer', scope: 'openid profile email' });
    expect(Object.keys(bpk).sort()).toEqual(Object.keys(bpw).sort());
  });
  it('DPoP：帶 dpop_jkt 時 code 綁定該金鑰；兌換必須由同一把金鑰簽 proof，token_type 為 DPoP', async () => {
    const a = await seeded();
    const key = await newKey(); const other = await newKey();
    expect((await exchange(await codeOf(await loginWith(a, { signCount: 1 }, { dpop_jkt: key.jkt })))).status).toBe(400); // 沒帶 proof
    expect((await exchange(await codeOf(await loginWith(a, { signCount: 2 }, { dpop_jkt: key.jkt })), await proof(other))).status).toBe(400); // 別把金鑰
    const ok = await exchange(await codeOf(await loginWith(a, { signCount: 3 }, { dpop_jkt: key.jkt })), await proof(key, { htu: 'http://localhost/api/oauth/token' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token_type: 'DPoP' });
  });
  it('scope 與密碼登入同規則：可要求較小的，超出 client 允許的 → 400', async () => {
    const a = await seeded();
    expect((await loginWith(a, { signCount: 1 }, { scope: 'openid profile' })).status).toBe(200);
    expect(JSON.parse(codeRows()[0]!.payload).scopes).toEqual(['openid', 'profile']);
    expect((await loginWith(a, { signCount: 2 }, { scope: 'openid admin:all' })).status).toBe(400);
  });
});

describe('簽名計數（偵測複製的憑證）', () => {
  it.each([['持平', 5], ['倒退', 4]])('計數%s：拒絕，不發 code，不更新計數，並記安全事件', async (_n, count) => {
    const a = await seeded(5);
    await expectRejected(await loginWith(a, { signCount: count }));
    expect(row(a.credId).sign_count).toBe(5);
    const ev = d1.raw.prepare("SELECT outcome, user_id, failure_reason FROM auth_audit_log WHERE event_type = 'signature_error'").all();
    expect(ev).toEqual([{ outcome: 'failure', user_id: 'u1', failure_reason: 'passkey_sign_count_regression' }]);
  });
  it('已有計數的憑證，回報 0 也視為倒退', async () => {
    const a = await seeded(5);
    await expectRejected(await loginWith(a, { signCount: 0 }));
  });
  it('併發：同一個憑證、同一個計數同時登入兩次，只有一個成功（條件式更新）', async () => {
    const a = await seeded();
    const [c1, c2] = [await getChallenge(), await getChallenge()];
    const [x, y] = [await assertion(a, c1, { signCount: 1 }), await assertion(a, c2, { signCount: 1 })];
    const res = await Promise.all([login(x), login(y)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(codeRows()).toHaveLength(1);
  });
  it('同一個 assertion 重送（挑戰已用掉）也不會成功', async () => {
    const a = await seeded();
    const ch = await getChallenge();
    const cred = await assertion(a, ch, { signCount: 1 });
    expect((await login(cred)).status).toBe(200);
    await d1.raw.prepare("DELETE FROM oauth_models WHERE name = 'AuthorizationCode'").run();
    await expectRejected(await login(cred));
  });
});

describe('挑戰：一次性、短時效、用途綁定', () => {
  it('重放：同一個挑戰第二次 → 401', async () => {
    const a = await seeded();
    const ch = await getChallenge();
    expect((await login(await assertion(a, ch, { signCount: 1 }))).status).toBe(200);
    d1.raw.prepare("DELETE FROM oauth_models WHERE name = 'AuthorizationCode'").run();
    await expectRejected(await login(await assertion(a, ch, { signCount: 2 })));
  });
  it('逾期 → 401', async () => {
    const a = await seeded();
    const ch = await getChallenge();
    d1.raw.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'PasskeyChallenge'").run(Date.now() - 1000);
    await expectRejected(await login(await assertion(a, ch)));
  });
  it('不是伺服器發的挑戰 → 401', async () => {
    await expectRejected(await login(await assertion(await seeded(), b64u(crypto.getRandomValues(new Uint8Array(32))))));
  });
  it('註冊用途的挑戰不能拿來登入', async () => {
    const a = await seeded();
    const ch = 'reg-challenge-for-u1';
    d1.raw.prepare("INSERT INTO oauth_models (id, name, payload, expires_at) VALUES (?, 'PasskeyChallenge', ?, ?)").run(ch, JSON.stringify({ user_id: 'u1', purpose: 'passkey-register' }), Date.now() + 60_000);
    await expectRejected(await login(await assertion(a, ch)));
  });
  it('驗證失敗也會消耗挑戰：必須重新取得', async () => {
    const a = await seeded();
    const ch = await getChallenge();
    await expectRejected(await login(await assertion(a, ch, { badSignature: true })));
    await expectRejected(await login(await assertion(a, ch)));
  });
});

describe('憑證屬主與存在性', () => {
  it('他人的憑證：userHandle 指向別人 → 401', async () => {
    const a = await seeded(); // 屬於 u1
    await expectRejected(await loginWith(a, { userHandle: handle('u2') }));
    expect(row(a.credId).sign_count).toBe(0);
  });
  it('停權的使用者 → 401', async () => {
    const a = await newAuthenticator();
    addUser('u3', 'sus@example.com', 'suspended');
    seedCredential('u3', a);
    await expectRejected(await loginWith(a));
  });
  it('未知憑證與「已知但驗證失敗」：回應完全相同（防帳號列舉）', async () => {
    const known = await seeded();
    const unknown = await newAuthenticator();
    const r1 = await loginWith(unknown);
    const r2 = await loginWith(known, { badSignature: true });
    const r3 = await loginWith(known, { userHandle: handle('u2') });
    expect(r1.status).toBe(401);
    const [b1, b2, b3] = [await r1.text(), await r2.text(), await r3.text()];
    expect(r2.status).toBe(401);
    expect(b1).toBe(b2);
    expect(b1).toBe(b3);
    expect(audit('login').map((e) => e.failure_reason)).toEqual(['passkey_unknown_credential', 'passkey_bad_signature', 'passkey_user_mismatch']);
  });
  it('簽名不是這把金鑰簽的 → 401（拿別人的公鑰對不上）', async () => {
    const a = await seeded();
    const impostor = { ...(await newAuthenticator()), credId: a.credId };
    await expectRejected(await loginWith(impostor));
  });
});

describe('assertion 驗證', () => {
  it('缺使用者驗證（UV）→ 401', async () => {
    await expectRejected(await loginWith(await seeded(), { flags: 0x01 }));
    expect(audit('login')[0]!.failure_reason).toBe('passkey_uv_required');
  });
  it('缺使用者在場（UP）→ 401', async () => {
    await expectRejected(await loginWith(await seeded(), { flags: 0x04 }));
  });
  it('錯誤網域：clientData.origin 不是本站 → 401', async () => {
    await expectRejected(await loginWith(await seeded(), { origin: 'https://evil.example' }));
    expect(audit('login')[0]!.failure_reason).toBe('passkey_origin_mismatch');
  });
  it('RP ID 雜湊不是本站 → 401', async () => {
    await expectRejected(await loginWith(await seeded(), { rpId: 'evil.example' }));
  });
  it('clientData.type 不是 webauthn.get → 401', async () => {
    await expectRejected(await loginWith(await seeded(), { type: 'webauthn.create' }));
  });
  it('簽名被竄改 → 401，計數不動', async () => {
    const a = await seeded(2);
    await expectRejected(await loginWith(a, { badSignature: true, signCount: 9 }));
    expect(row(a.credId).sign_count).toBe(2);
  });
});

describe('PASSKEY_EXTRA_ORIGINS（追加來源，例如 Android 原生 App）', () => {
  const ANDROID = 'android:apk-key-hash:AbCdEf_-123';
  const extra = (v: string) => ({ DB: d1.db, ALLOWED_ORIGINS: '', PASSKEY_EXTRA_ORIGINS: v }) as Env;
  it('預設空：行為不變，passkeyRp 只有 web 網域', () => {
    expect(passkeyRp({} as Env)).toEqual({ id: RP_ID, origins: [ORIGIN] });
    expect(passkeyRp({ PASSKEY_EXTRA_ORIGINS: '' } as Env).origins).toEqual([ORIGIN]);
  });
  it('逗號分隔追加，去空白、略過空項，web 網域仍保留', () => {
    expect(passkeyRp({ PASSKEY_EXTRA_ORIGINS: ` ${ANDROID} , ,https://other.example ` } as Env).origins).toEqual([ORIGIN, ANDROID, 'https://other.example']);
  });
  it('未設定時，Android 來源被拒；設定後被接受', async () => {
    const a = await seeded();
    await expectRejected(await loginWith(a, { origin: ANDROID }));
    expect((await loginWith(a, { origin: ANDROID, signCount: 1 }, {}, '1.1.1.1', extra(ANDROID))).status).toBe(200);
  });
  it('設定後，沒列在清單的來源仍被拒', async () => {
    await expectRejected(await loginWith(await seeded(), { origin: 'android:apk-key-hash:other' }, {}, '1.1.1.1', extra(ANDROID)));
  });
});

describe('輸入檢查與 client', () => {
  it('非第一方 client → 400，不洩漏原因', async () => {
    const a = await seeded();
    const ch = await getChallenge();
    const res = await login(await assertion(a, ch), { client_id: 'no-such-client' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Err).error.code).toBe('LOGIN_INVALID_INPUT');
  });
  it.each([
    ['缺 credential', { credential: undefined }],
    ['credential.id 不是字串', { credential: { id: 1, response: {} } }],
    ['缺 signature', { credential: { id: 'x', response: { clientDataJSON: 'a', authenticatorData: 'a' } } }],
    ['code_challenge_method=plain', { code_challenge_method: 'plain' }],
    ['code_challenge 長度不對', { code_challenge: 'abc' }],
    ['dpop_jkt 格式不對', { dpop_jkt: 'short' }],
  ])('%s → 400 LOGIN_INVALID_INPUT', async (_n, over) => {
    const res = await call('/api/oauth/passkey/login', { ...grant, ...over });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Err).error.code).toBe('LOGIN_INVALID_INPUT');
  });
  it('clientDataJSON 不是合法資料 → 401（與其他驗證失敗相同）', async () => {
    await expectRejected(await login({ id: 'x', response: { clientDataJSON: '!!!', authenticatorData: 'AA', signature: 'AA' } }));
  });
});

describe('限流與安全事件', () => {
  it('同一個 IP 失敗超過上限後鎖住：429 LOGIN_RATE_LIMITED（附 Retry-After），並記 rate_limited 安全事件', async () => {
    const unknown = await newAuthenticator();
    for (let i = 0; i < 50; i++) expect((await loginWith(unknown, {}, {}, '7.7.7.7')).status).toBe(401);
    const locked = await loginWith(unknown, {}, {}, '7.7.7.7');
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBeTruthy();
    expect(((await locked.json()) as Err).error.code).toBe('LOGIN_RATE_LIMITED');
    expect(audit('rate_limited').map((e) => e.failure_reason)).toEqual(['passkey_ip_locked']);
  }, 60_000);
  it('成功退還這一次嘗試：已累積 49 次淨失敗的 IP，連續成功也不會被鎖', async () => {
    d1.raw.prepare('INSERT INTO rate_limit_buckets (bucket_key, count, window_start) VALUES (?, 49, ?)').run('passkey-login:8.8.8.8', Date.now());
    const a = await seeded();
    for (let i = 1; i <= 5; i++) expect((await loginWith(a, { signCount: i }, {}, '8.8.8.8')).status).toBe(200);
    expect((d1.raw.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').get('passkey-login:8.8.8.8') as { count: number }).count).toBe(49);
  });
  it('失敗寫入 audit（login／failure、帶使用者 id 與 client）', async () => {
    const a = await seeded();
    await loginWith(a, { badSignature: true });
    const ev = d1.raw.prepare("SELECT outcome, user_id, client_id, failure_reason FROM auth_audit_log WHERE event_type = 'login'").all();
    expect(ev).toEqual([{ outcome: 'failure', user_id: 'u1', client_id: 'tripline-web', failure_reason: 'passkey_bad_signature' }]);
  });
});
