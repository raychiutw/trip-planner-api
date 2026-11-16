/**
 * 授權契約單一出處（src/lib/oauth-contract.ts）的守門：
 * 1. OpenAPI 文件上的 enum 值必須等於契約常數（web 由此產生型別）；常數本身也釘死字面值。
 * 2. 登入碼 TTL 與「不帶 redirect_uri」（第一方直接換 token）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { hashPassword } from '../src/lib/password';
import {
  BIOMETRIC_BUTTON_HINTS, BIOMETRIC_HINTS, BIOMETRIC_INTENTS, LOGIN_CODE_TTL_SEC,
  PARAM_BIOMETRIC_INTENT, PARAM_THEME, THEMES,
} from '../src/lib/oauth-contract';
import * as contract from '../src/lib/oauth-contract';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
let HASH: string;
const PASSWORD = 'correct-horse-battery';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

beforeEach(async () => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  HASH ??= await hashPassword(PASSWORD);
  d1.raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
  d1.raw.prepare("INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash, password_algo) VALUES ('u1', 'local', 'a@example.com', ?, 'pbkdf2')").run(HASH);
});
afterEach(() => { d1.close(); vi.useRealTimers(); });

describe('契約常數的字面值（少一個值就紅）', () => {
  it('白名單與錯誤值', () => {
    expect([...BIOMETRIC_HINTS]).toEqual(['faceid', 'touchid', 'generic']);
    expect([...BIOMETRIC_BUTTON_HINTS]).toEqual(['faceid', 'touchid']);
    expect([...BIOMETRIC_INTENTS]).toEqual(['enable']);
    expect(PARAM_BIOMETRIC_INTENT).toBe('biometric_intent');
    expect([...THEMES]).toEqual(['light', 'dark']);
    expect(PARAM_THEME).toBe('theme');
  });
});

type Json = Record<string, unknown>;
/** 在 schema 子樹（含 anyOf／type 陣列）裡收集所有 enum 陣列。 */
function enumsOf(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) node.forEach((n) => enumsOf(n, out));
  else if (node && typeof node === 'object') {
    const o = node as Json;
    if (Array.isArray(o.enum)) out.push(o.enum.filter((v) => v !== null)); // nullable 的 enum 會多一個 null
    Object.values(o).forEach((v) => enumsOf(v, out));
  }
  return out;
}
async function spec() {
  return (await (await createApp().request('/openapi.json', {}, env)).json()) as { paths: Record<string, Record<string, Json>>; components: { schemas: Record<string, Json> } };
}

describe('重新驗證模式已移除（ADR-0019）', () => {
  it('契約不再匯出重新驗證的常數', () => {
    for (const name of ['PROMPT_LOGIN', 'REAUTH_LOGIN', 'REAUTH_MODES', 'REAUTH_ACCOUNT_MISMATCH', 'PARAM_REAUTH', 'PARAM_EXPECTED_ACCOUNT', 'LOGIN_CODE_REDIRECT_URI']) {
      expect(contract).not.toHaveProperty(name);
    }
  });
  it('OpenAPI 的 authorize 不再列 biometric_intent、expected_account；全文不再出現重新驗證錯誤碼', async () => {
    const s = await spec();
    const names = (s.paths['/api/oauth/authorize']!.get!.parameters as { name: string }[]).map((p) => p.name);
    expect(names).not.toContain('biometric_intent');
    expect(names).not.toContain('expected_account');
    const text = JSON.stringify(s);
    expect(text).not.toContain('OAUTH_REAUTH_REQUIRED');
    expect(text).not.toContain('reauth_account_mismatch');
  });
});

describe('OpenAPI 的 enum 等於契約常數', () => {
  it('GET /authorize 的 biometric_hint、theme', async () => {
    const s = await spec();
    const params = s.paths['/api/oauth/authorize']!.get!.parameters as { name: string; schema: unknown }[];
    const of = (n: string) => enumsOf(params.find((p) => p.name === n)!.schema);
    expect(of('biometric_hint')).toEqual([[...BIOMETRIC_HINTS]]);
    expect(of('theme')).toEqual([[...THEMES]]);
  });
  it('GET requests/:id 的 biometric_hint（只有按鈕提示值）', async () => {
    const s = await spec();
    const schema = (s.paths['/api/oauth/authorize/requests/{id}']!.get!.responses as Json)['200'] as Json;
    const ref = (((schema.content as Json)['application/json'] as Json).schema as { $ref: string }).$ref;
    const props = s.components.schemas[ref.split('/').pop()!]!.properties as Json;
    expect(enumsOf(props.biometric_hint)).toEqual([[...BIOMETRIC_BUTTON_HINTS]]);
  });
  it('POST intent 的 body.intent', async () => {
    const s = await spec();
    const body = ((s.paths['/api/oauth/authorize/requests/{id}/intent']!.post!.requestBody as Json).content as Json)['application/json'] as Json;
    expect(enumsOf(((body.schema as Json).properties as Json).intent)).toEqual([[...BIOMETRIC_INTENTS]]);
  });
});

describe('登入碼 TTL 與 redirect_uri 約定（login 端點）', () => {
  it('釘死 TTL 字面值', () => {
    expect(LOGIN_CODE_TTL_SEC).toBe(60);
  });

  async function loginAndExchange() {
    const login = await createApp().request('/api/oauth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
      body: JSON.stringify({ email: 'a@example.com', password: PASSWORD, client_id: 'tripline-web', code_challenge: CHALLENGE, code_challenge_method: 'S256' }),
    }, env);
    expect(login.status).toBe(200);
    const { code, expires_in } = (await login.json()) as { code: string; expires_in: number };
    const token = await createApp().request('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '2.2.2.2' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'tripline-web', code, code_verifier: VERIFIER }).toString(),
    }, env);
    expect(token.status).toBe(200);
    const row = d1.raw.prepare("SELECT payload, expires_at FROM oauth_models WHERE name = 'AuthorizationCode' AND id = ?").get(code) as { payload: string; expires_at: number };
    return { expires_in, row, payload: JSON.parse(row.payload) as { grantId: string; redirect_uri: unknown } };
  }

  it('登入端點簽的碼：expires_in、儲存的到期時間與 redirect_uri 都依契約', async () => {
    const before = Date.now();
    const { expires_in, row, payload } = await loginAndExchange();
    expect(expires_in).toBe(LOGIN_CODE_TTL_SEC);
    expect(payload.redirect_uri).toBeNull();
    expect(row.expires_at).toBeGreaterThanOrEqual(before + LOGIN_CODE_TTL_SEC * 1000);
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + LOGIN_CODE_TTL_SEC * 1000);
  });

});
