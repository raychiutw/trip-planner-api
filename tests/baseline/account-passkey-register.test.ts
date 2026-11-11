/**
 * passkey 註冊（spec web#1677、票 api#78）：
 *   POST /api/account/passkeys/register/options  發出一次性、短時效的註冊挑戰
 *   POST /api/account/passkeys/register/verify   驗證回傳的憑證後儲存，並寄「新增了一組 passkey」通知信
 *
 * 走 HTTP 邊界：真實 bearer → middleware → handler。WebAuthn 的 attestation 與 clientData 由本檔用
 * WebCrypto 現場產生的拋棄式金鑰組出來，不含任何真實金鑰或憑證。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { sessionFor, type TestSession } from './account-session-helper';
import { eraseUserAccount } from '../../src/lib/erasure';

const PREFIX = 'pkreg';
const RP_ID = 'trip-planner-dby.pages.dev';
const ORIGIN = `https://${RP_ID}`;
const MAILER = { TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'test-bearer' };

let db: D1Database;
let api: Api;
let seq = 0;
const userIds: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db, MAILER) });
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); });

afterAll(async () => {
  for (const id of userIds) {
    await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM oauth_models WHERE json_extract(payload, \'$.user_id\') = ?').bind(id).run();
    await db.prepare('DELETE FROM auth_audit_log WHERE user_id = ?').bind(id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

async function seed(): Promise<TestSession & { email: string }> {
  const id = `${PREFIX}-u${++seq}`;
  const email = `${id}@example.com`;
  userIds.push(id);
  return { ...(await sessionFor(db, email, id)), email };
}

// ───────── 假的 authenticator（WebCrypto 拋棄式金鑰）─────────

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const head = (major: number, n: number) =>
  n < 24 ? Uint8Array.of((major << 5) | n)
    : n < 256 ? Uint8Array.of((major << 5) | 24, n)
      : Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = enc.encode(v); return cat(head(3, s.length), s); }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

interface AttOpts { rpId?: string; flags?: number; credId?: Uint8Array; alg?: number }
async function attestation(opts: AttOpts = {}) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer); // 04||x||y
  const cose = cbor(new Map<number, Cbor>([[1, 2], [3, opts.alg ?? -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]]));
  const credId = opts.credId ?? crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(opts.rpId ?? RP_ID)));
  // flags：UP 0x01、UV 0x04、BE 0x08、AT 0x40
  const authData = cat(rpHash, Uint8Array.of(opts.flags ?? 0x45), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cose);
  const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return { credId: b64u(credId), attestationObject: b64u(attestationObject) };
}
const clientData = (challenge: string, over: Record<string, unknown> = {}) =>
  b64u(enc.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false, ...over })));

// ───────── HTTP ─────────

const mails = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/internal/mail/send'));
const stubMailer = (res: Response = new Response(JSON.stringify({ ok: true, messageId: 'm1', elapsed: 5 }), { status: 200 })) => {
  const fetchMock = vi.fn().mockResolvedValue(res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const options = (bearer?: string) => api.request('POST', '/api/account/passkeys/register/options', { bearer, json: {} });
const verify = (bearer: string | undefined, json: unknown) => api.request('POST', '/api/account/passkeys/register/verify', { bearer, json });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const rows = async (userId: string) =>
  (await db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ?').bind(userId).all<Record<string, unknown>>()).results;

async function challengeFor(bearer: string): Promise<string> {
  const res = await options(bearer);
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}
function body(att: { credId: string; attestationObject: string }, clientDataJSON: string, extra: Record<string, unknown> = {}) {
  return { credential: { id: att.credId, type: 'public-key', response: { clientDataJSON, attestationObject: att.attestationObject, transports: ['internal', 'hybrid'] } }, ...extra };
}

describe('POST /api/account/passkeys/register/options', () => {
  it('401 未登入', async () => {
    expect((await options()).status).toBe(401);
  });

  it('回註冊選項：RP ID、必須做使用者驗證、只收 ES256、user.id 綁本人、每次挑戰不同', async () => {
    const u = await seed();
    const res = await options(u.bearer);
    expect(res.status).toBe(200);
    const o = (await res.json()) as any;
    expect(o.rp.id).toBe(RP_ID);
    expect(o.authenticatorSelection).toMatchObject({ userVerification: 'required', residentKey: 'required' });
    expect(o.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(o.attestation).toBe('none');
    expect(o.user.name).toBe(u.email);
    expect(Buffer.from(o.user.id, 'base64url').toString()).toBe(u.userId);
    expect(Buffer.from(o.challenge, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(await challengeFor(u.bearer)).not.toBe(o.challenge);
  });

  it('excludeCredentials 帶已註冊的憑證，避免同一個 authenticator 重複註冊', async () => {
    const u = await seed();
    stubMailer();
    const att = await attestation();
    const ch = await challengeFor(u.bearer);
    expect((await verify(u.bearer, body(att, clientData(ch)))).status).toBe(201);
    const o = (await (await options(u.bearer)).json()) as any;
    expect(o.excludeCredentials.map((c: any) => c.id)).toEqual([att.credId]);
  });
});

describe('POST /api/account/passkeys/register/verify', () => {
  it('401 未登入', async () => {
    const att = await attestation();
    expect((await verify(undefined, body(att, clientData('x')))).status).toBe(401);
  });

  it('成功：201、憑證存進 DB（公鑰、計數 0、名稱、傳輸方式、建立時間）、稽核 success', async () => {
    const u = await seed();
    stubMailer();
    const att = await attestation({ flags: 0x45 | 0x08 }); // 可同步（BE）
    const res = await verify(u.bearer, body(att, clientData(await challengeFor(u.bearer)), { name: '我的 iPhone' }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as any;
    expect(out).toMatchObject({ id: att.credId, name: '我的 iPhone', transports: ['internal', 'hybrid'], backupEligible: true });
    expect(out.createdAt).toBeTruthy();
    const [row] = await rows(u.userId);
    expect(row).toMatchObject({ id: att.credId, user_id: u.userId, sign_count: 0, name: '我的 iPhone', backup_eligible: 1 });
    expect(row!.public_key).toBeTruthy();
    expect(JSON.parse(row!.transports as string)).toEqual(['internal', 'hybrid']);
    const audit = await db.prepare(`SELECT outcome FROM auth_audit_log WHERE user_id = ? AND event_type = 'passkey_register'`).bind(u.userId).first<{ outcome: string }>();
    expect(audit?.outcome).toBe('success');
  });

  it('成功：沒給名稱用預設名稱', async () => {
    const u = await seed();
    stubMailer();
    const att = await attestation();
    expect((await verify(u.bearer, body(att, clientData(await challengeFor(u.bearer))))).status).toBe(201);
    expect((await rows(u.userId))[0]!.name).toBe('Passkey');
  });

  it('成功：寄出「新增了一組 passkey」通知信給本人', async () => {
    const u = await seed();
    const m = stubMailer();
    const att = await attestation();
    await verify(u.bearer, body(att, clientData(await challengeFor(u.bearer))));
    const sent = mails(m);
    expect(sent).toHaveLength(1);
    const payload = String(sent[0]![1]?.body);
    expect(payload).toContain(u.email);
    expect(payload).toContain('passkey');
    expect(payload).toContain('新增');
  });

  it('成功：寄信失敗不影響結果（仍 201、憑證已存）', async () => {
    const u = await seed();
    stubMailer(new Response('boom', { status: 500 }));
    const att = await attestation();
    expect((await verify(u.bearer, body(att, clientData(await challengeFor(u.bearer))))).status).toBe(201);
    expect(await rows(u.userId)).toHaveLength(1);
  });

  it('挑戰重放被拒：同一個挑戰第二次送出 → 400 PASSKEY_CHALLENGE_INVALID，只存一筆', async () => {
    const u = await seed();
    stubMailer();
    const ch = await challengeFor(u.bearer);
    const first = await attestation();
    expect((await verify(u.bearer, body(first, clientData(ch)))).status).toBe(201);
    const second = await attestation();
    const replay = await verify(u.bearer, body(second, clientData(ch)));
    expect(replay.status).toBe(400);
    expect(await code(replay)).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(await rows(u.userId)).toHaveLength(1);
  });

  it('挑戰逾期被拒：400 PASSKEY_CHALLENGE_INVALID，不存、不寄信', async () => {
    const u = await seed();
    const m = stubMailer();
    const ch = await challengeFor(u.bearer);
    await db.prepare(`UPDATE oauth_models SET expires_at = ? WHERE id = ?`).bind(Date.now() - 1000, ch).run();
    const res = await verify(u.bearer, body(await attestation(), clientData(ch)));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(await rows(u.userId)).toHaveLength(0);
    expect(mails(m)).toHaveLength(0);
  });

  it('挑戰逾期時間：發出的挑戰有效期在 10 分鐘內', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const row = await db.prepare(`SELECT expires_at FROM oauth_models WHERE id = ?`).bind(ch).first<{ expires_at: number }>();
    expect(row!.expires_at - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(row!.expires_at - Date.now()).toBeGreaterThan(0);
  });

  it('不是這個使用者領的挑戰被拒（別人的挑戰不能拿來註冊到自己名下）', async () => {
    const a = await seed();
    const b = await seed();
    stubMailer();
    const ch = await challengeFor(a.bearer);
    const res = await verify(b.bearer, body(await attestation(), clientData(ch)));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(await rows(b.userId)).toHaveLength(0);
  });

  it('沒領過的挑戰被拒', async () => {
    const u = await seed();
    const res = await verify(u.bearer, body(await attestation(), clientData(b64u(crypto.getRandomValues(new Uint8Array(32))))));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_CHALLENGE_INVALID');
  });

  it('錯誤網域被拒：clientData 的 origin 不是 web 網域 → 400 PASSKEY_ORIGIN_MISMATCH，不存、不寄信', async () => {
    const u = await seed();
    const m = stubMailer();
    const ch = await challengeFor(u.bearer);
    const res = await verify(u.bearer, body(await attestation(), clientData(ch, { origin: 'https://evil.example.com' })));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_ORIGIN_MISMATCH');
    expect(await rows(u.userId)).toHaveLength(0);
    expect(mails(m)).toHaveLength(0);
  });

  it('錯誤網域被拒：authenticatorData 的 RP ID 雜湊不是本站 → 400 PASSKEY_REGISTRATION_INVALID', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const res = await verify(u.bearer, body(await attestation({ rpId: 'evil.example.com' }), clientData(ch)));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_REGISTRATION_INVALID');
    expect(await rows(u.userId)).toHaveLength(0);
  });

  it('未做使用者驗證被拒：UV 旗標沒設（只有 UP）→ 400 PASSKEY_UV_REQUIRED，不存、不寄信', async () => {
    const u = await seed();
    const m = stubMailer();
    const ch = await challengeFor(u.bearer);
    const res = await verify(u.bearer, body(await attestation({ flags: 0x41 }), clientData(ch)));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_UV_REQUIRED');
    expect(await rows(u.userId)).toHaveLength(0);
    expect(mails(m)).toHaveLength(0);
  });

  it('clientData 的 type 不是 webauthn.create 被拒', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const res = await verify(u.bearer, body(await attestation(), clientData(ch, { type: 'webauthn.get' })));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_REGISTRATION_INVALID');
  });

  it('不支援的演算法被拒（只收 ES256）', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const res = await verify(u.bearer, body(await attestation({ alg: -8 }), clientData(ch)));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_REGISTRATION_INVALID');
  });

  it('回傳的憑證 ID 與 authenticatorData 內的不一致被拒', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const att = await attestation();
    const res = await verify(u.bearer, body({ ...att, credId: b64u(crypto.getRandomValues(new Uint8Array(32))) }, clientData(ch)));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PASSKEY_REGISTRATION_INVALID');
  });

  it('壞掉的 body（不是 attestation）→ 400', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    const res = await verify(u.bearer, { credential: { id: 'x', type: 'public-key', response: { clientDataJSON: clientData(ch), attestationObject: 'AAAA' } } });
    expect(res.status).toBe(400);
    expect(await rows(u.userId)).toHaveLength(0);
  });

  it('409 PASSKEY_ALREADY_REGISTERED：同一個憑證 ID 已被註冊（含別的使用者）', async () => {
    const a = await seed();
    const b = await seed();
    stubMailer();
    const credId = crypto.getRandomValues(new Uint8Array(32));
    expect((await verify(a.bearer, body(await attestation({ credId }), clientData(await challengeFor(a.bearer))))).status).toBe(201);
    const res = await verify(b.bearer, body(await attestation({ credId }), clientData(await challengeFor(b.bearer))));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('PASSKEY_ALREADY_REGISTERED');
    expect(await rows(b.userId)).toHaveLength(0);
  });

  it('失敗的註冊留下稽核 failure 與原因', async () => {
    const u = await seed();
    const ch = await challengeFor(u.bearer);
    await verify(u.bearer, body(await attestation({ flags: 0x41 }), clientData(ch)));
    const row = await db.prepare(`SELECT outcome, failure_reason FROM auth_audit_log WHERE user_id = ? AND event_type = 'passkey_register'`).bind(u.userId).first();
    expect(row).toEqual({ outcome: 'failure', failure_reason: 'uv_required' });
  });
});

describe('刪除帳號', () => {
  it('連帶刪除該使用者的 passkey 憑證，別人的不受影響', async () => {
    const a = await seed();
    const b = await seed();
    stubMailer();
    for (const u of [a, b]) {
      expect((await verify(u.bearer, body(await attestation(), clientData(await challengeFor(u.bearer))))).status).toBe(201);
    }
    await eraseUserAccount(db, a.userId);
    expect(await rows(a.userId)).toHaveLength(0);
    expect(await rows(b.userId)).toHaveLength(1);
  });
});
