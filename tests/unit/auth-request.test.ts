/**
 * 授權請求 module（src/lib/auth-request.ts）：create／peek／setIntent／take 與 payload 形狀。
 * 原本散在 HTTP 測試裡、直接讀寫 oauth_models payload 的斷言都收在這裡。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AUTH_REQUEST_TTL_SEC, EXPECTED_ACCOUNT_RE, buildAuthRequestPayload, createAuthRequest, isAuthRequest,
  parseReauth, peekAuthRequest, setAuthRequestIntent, takeAuthRequest,
} from '../../src/lib/auth-request';
import type { ValidatedRequest } from '../../src/lib/oauth-server/validate-authorize-request';
import { createD1 } from '../support/d1';

let d1: ReturnType<typeof createD1>;
beforeEach(() => { d1 = createD1(); });
afterEach(() => d1.close());

const VALIDATED = {
  client: { client_id: 'c1' }, redirectUri: 'https://x.com/cb', scopes: ['openid', 'profile'], state: 'csrf-xyz',
  codeChallenge: 'pkce-abc', codeChallengeMethod: 'S256', prompt: null,
} as unknown as ValidatedRequest;

const rawRow = (id: string) => d1.raw.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'AuthRequest' AND id = ?").get(id) as { payload: string; expires_at: number } | undefined;

describe('TTL 與 payload 形狀（取代 authorize 測試直接讀 oauth_models 的斷言）', () => {
  it('TTL 是 10 分鐘', () => expect(AUTH_REQUEST_TTL_SEC).toBe(600));

  it('create：存驗過的參數，到期時間約 10 分鐘，id 為 32 bytes base64url 且每次不同', async () => {
    const before = Date.now();
    const a = await createAuthRequest(d1.db, buildAuthRequestPayload(VALIDATED, { biometricHint: null, reauth: null }));
    const b = await createAuthRequest(d1.db, buildAuthRequestPayload(VALIDATED, { biometricHint: null, reauth: null }));
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    const row = rawRow(a)!;
    expect(JSON.parse(row.payload)).toMatchObject({
      client_id: 'c1', redirect_uri: 'https://x.com/cb', scopes: ['openid', 'profile'], state: 'csrf-xyz',
      code_challenge: 'pkce-abc', code_challenge_method: 'S256', prompt: null, biometric_hint: null,
    });
    expect(row.expires_at).toBeGreaterThanOrEqual(before + 600_000);
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('一般與單獨 prompt=login 不記 reauth_intent／expected_account；reauth 才記', () => {
    for (const prompt of [null, 'consent', 'login']) {
      const p = buildAuthRequestPayload({ ...VALIDATED, prompt }, { biometricHint: 'faceid', reauth: null });
      expect(p.reauth_intent).toBeUndefined();
      expect(p.expected_account).toBeUndefined();
      expect(p.biometric_hint).toBe('faceid');
    }
    const r = buildAuthRequestPayload({ ...VALIDATED, prompt: 'login' }, { biometricHint: null, reauth: { intent: 'disable', expectedAccount: 'u-1' } });
    expect(r).toMatchObject({ reauth_intent: 'disable', expected_account: 'u-1' });
  });

  it('create 可指定 id 與 TTL；過期的 peek／take 讀不到', async () => {
    const id = await createAuthRequest(d1.db, buildAuthRequestPayload(VALIDATED, { biometricHint: null, reauth: null }), { id: 'fixed', ttlSec: -1 });
    expect(id).toBe('fixed');
    expect(await peekAuthRequest(d1.db, 'fixed')).toBeUndefined();
    expect(await takeAuthRequest(d1.db, 'fixed')).toBeUndefined();
  });
});

describe('parseReauth（reauth 啟動條件）', () => {
  const ACC = 'user-1';
  it.each([
    ['login', 'enable', ACC, { kind: 'reauth', intent: 'enable', expectedAccount: ACC }],
    ['login', 'disable', ACC, { kind: 'reauth', intent: 'disable', expectedAccount: ACC }],
    ['login', 'enable', '', { kind: 'invalid_account' }],
    ['login', 'enable', 'has space', { kind: 'invalid_account' }],
    ['login', 'enable', 'a'.repeat(65), { kind: 'invalid_account' }],
    ['login', 'enable', 'x&y=1', { kind: 'invalid_account' }],
    ['login', null, ACC, { kind: 'none' }],
    ['login', 'delete-all', 'x&y', { kind: 'none' }],
    ['login', 'ENABLE', ACC, { kind: 'none' }],
    [null, 'enable', ACC, { kind: 'none' }],
    ['consent', 'enable', ACC, { kind: 'none' }],
  ])('prompt=%s intent=%s account=%j → %j', (prompt, intent, account, expected) => {
    expect(parseReauth(prompt, intent, account)).toEqual(expected);
  });
  it('EXPECTED_ACCOUNT_RE：只收單純字元、1~64', () => {
    expect(EXPECTED_ACCOUNT_RE.test('Ab_-9')).toBe(true);
    expect(EXPECTED_ACCOUNT_RE.test('../etc')).toBe(false);
  });
});

describe('isAuthRequest', () => {
  it.each([[{ client_id: 'c', redirect_uri: 'r', scopes: [] }, true], [{ client_id: 'c', redirect_uri: 'r' }, false], [undefined, false], [{ client_id: 1, redirect_uri: 'r', scopes: [] }, false]])('%j → %s', (p, ok) => {
    expect(isAuthRequest(p)).toBe(ok);
  });
});

describe('setIntent 與 intent_user_id 綁定', () => {
  const make = (over = {}) => createAuthRequest(d1.db, { ...buildAuthRequestPayload(VALIDATED, { biometricHint: null, reauth: null }), ...over });

  it('設定者綁定：設值記下設定者；null 清掉兩者；後設者蓋過且改綁後設者', async () => {
    const id = await make();
    expect(await setAuthRequestIntent(d1.db, id, 'enable', 'u-a')).toBe('ok');
    expect((await peekAuthRequest(d1.db, id))!.payload).toMatchObject({ intent: 'enable', intent_user_id: 'u-a' });
    expect(await setAuthRequestIntent(d1.db, id, 'disable', 'u-b')).toBe('ok');
    expect((await peekAuthRequest(d1.db, id))!.payload).toMatchObject({ intent: 'disable', intent_user_id: 'u-b' });
    expect(await setAuthRequestIntent(d1.db, id, null, 'u-b')).toBe('ok');
    expect((await peekAuthRequest(d1.db, id))!.payload).toMatchObject({ intent: null, intent_user_id: null });
  });

  it('非白名單值 → invalid_intent，不改動', async () => {
    const id = await make();
    for (const bad of ['delete-all', undefined, 1, 'ENABLE']) expect(await setAuthRequestIntent(d1.db, id, bad, 'u-a')).toBe('invalid_intent');
    expect((await peekAuthRequest(d1.db, id))!.payload.intent).toBeUndefined();
  });

  it('reauth 請求不可設意圖（先於值檢查），也不被改動', async () => {
    const id = await make({ reauth_intent: 'enable', expected_account: 'u-a' });
    expect(await setAuthRequestIntent(d1.db, id, 'disable', 'u-a')).toBe('reauth');
    expect(await setAuthRequestIntent(d1.db, id, 'nonsense', 'u-a')).toBe('reauth');
    expect((await peekAuthRequest(d1.db, id))!.payload.intent).toBeUndefined();
  });

  it('不存在、已被取用、已過期的請求不能被意圖「復活」', async () => {
    expect(await setAuthRequestIntent(d1.db, 'nope', 'enable', 'u-a')).toBe('gone');
    const id = await make();
    expect(await takeAuthRequest(d1.db, id)).toBeDefined();
    expect(await setAuthRequestIntent(d1.db, id, 'enable', 'u-a')).toBe('gone');
    expect(rawRow(id)).toBeUndefined();
    const expired = await make({}); 
    d1.raw.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'AuthRequest' AND id = ?").run(Date.now() - 1, expired);
    expect(await setAuthRequestIntent(d1.db, expired, 'enable', 'u-a')).toBe('gone');
  });
});

describe('take：單次使用', () => {
  it('第一次拿到 payload，之後（重放）拿不到；peek 不消耗', async () => {
    const id = await createAuthRequest(d1.db, buildAuthRequestPayload(VALIDATED, { biometricHint: null, reauth: null }));
    expect((await peekAuthRequest(d1.db, id))!.payload.client_id).toBe('c1');
    expect((await peekAuthRequest(d1.db, id))!.expiresAt).toBeGreaterThan(Date.now());
    expect((await takeAuthRequest(d1.db, id))!.client_id).toBe('c1');
    expect(await takeAuthRequest(d1.db, id)).toBeUndefined();
    expect(await peekAuthRequest(d1.db, id)).toBeUndefined();
  });
  it('空 id 與形狀不對的資料 → undefined', async () => {
    expect(await takeAuthRequest(d1.db, '')).toBeUndefined();
    d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AuthRequest', 'bad', '{\"x\":1}', ?)").run(Date.now() + 60_000);
    expect(await takeAuthRequest(d1.db, 'bad')).toBeUndefined();
    expect(await peekAuthRequest(d1.db, 'bad')).toBeUndefined();
  });
});
