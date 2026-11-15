/**
 * 批准決策純函式（不經資料庫）：授權請求 + 批准者 + 新鮮度 → 判別式結果。
 * 表格涵蓋：一般批准、帶意圖、reauth 通過、帳號不符、需要重新登入、單獨 prompt=login、deny。
 */
import { describe, it, expect } from 'vitest';
import { decideApproval, requiresFreshLogin } from '../../src/lib/oauth-server/approve-decision';
import type { AuthRequestPayload } from '../../src/lib/auth-request';

const BASE: AuthRequestPayload = {
  client_id: 'c', redirect_uri: 'https://x.com/cb', scopes: ['openid'], state: 's',
  code_challenge: 'ch', code_challenge_method: 'S256', prompt: null,
};
const ME = 'user-me';
const OTHER = 'user-other';
const REAUTH: AuthRequestPayload = { ...BASE, prompt: 'login', reauth_intent: 'enable', expected_account: ME };

type Case = { name: string; decision: 'approve' | 'deny'; req: AuthRequestPayload; userId: string; freshLogin: boolean; expected: unknown };
const cases: Case[] = [
  { name: '一般批准：沒有旗標', decision: 'approve', req: BASE, userId: ME, freshLogin: false, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '帶意圖：設定者就是批准者 → 旗標', decision: 'approve', req: { ...BASE, intent: 'disable', intent_user_id: ME }, userId: ME, freshLogin: false, expected: { kind: 'approve', biometricIntent: 'disable' } },
  { name: '帶意圖：別人批准 → 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'enable', intent_user_id: ME }, userId: OTHER, freshLogin: false, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '帶意圖：沒有設定者 → 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'enable' }, userId: ME, freshLogin: false, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '意圖不在白名單 → 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'https://evil.test&x=1' as never, intent_user_id: ME }, userId: ME, freshLogin: false, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: 'reauth 通過：帳號相符且剛登入 → 旗標取自 reauth_intent', decision: 'approve', req: REAUTH, userId: ME, freshLogin: true, expected: { kind: 'approve', biometricIntent: 'enable' } },
  { name: 'reauth 下 intent／intent_user_id 不能覆寫', decision: 'approve', req: { ...REAUTH, intent: 'disable', intent_user_id: ME }, userId: ME, freshLogin: true, expected: { kind: 'approve', biometricIntent: 'enable' } },
  { name: 'reauth 帳號不符', decision: 'approve', req: REAUTH, userId: OTHER, freshLogin: true, expected: { kind: 'account_mismatch' } },
  { name: 'reauth 不是剛登入 → 需要重新登入（先於帳號比對）', decision: 'approve', req: REAUTH, userId: OTHER, freshLogin: false, expected: { kind: 'reauth_required' } },
  { name: 'reauth 帳號相符但不是剛登入 → 需要重新登入', decision: 'approve', req: REAUTH, userId: ME, freshLogin: false, expected: { kind: 'reauth_required' } },
  { name: '單獨 prompt=login 不是剛登入 → 需要重新登入', decision: 'approve', req: { ...BASE, prompt: 'login' }, userId: ME, freshLogin: false, expected: { kind: 'reauth_required' } },
  { name: '單獨 prompt=login 剛登入 → 批准，不比對帳號', decision: 'approve', req: { ...BASE, prompt: 'login' }, userId: OTHER, freshLogin: true, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '單獨 prompt=login 仍可帶意圖旗標', decision: 'approve', req: { ...BASE, prompt: 'login', intent: 'enable', intent_user_id: OTHER }, userId: OTHER, freshLogin: true, expected: { kind: 'approve', biometricIntent: 'enable' } },
  { name: '沒有 prompt=login 但有 expected_account：不檢查帳號與新鮮度', decision: 'approve', req: { ...BASE, expected_account: ME }, userId: OTHER, freshLogin: false, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: 'deny：一般', decision: 'deny', req: BASE, userId: ME, freshLogin: false, expected: { kind: 'deny' } },
  { name: 'deny：reauth 不受新鮮度與帳號限制', decision: 'deny', req: REAUTH, userId: OTHER, freshLogin: false, expected: { kind: 'deny' } },
];

describe('decideApproval（純函式表格）', () => {
  it.each(cases)('$name', ({ decision, req, userId, freshLogin, expected }) => {
    expect(decideApproval({ decision, req, userId, freshLogin })).toEqual(expected);
  });
});

describe('requiresFreshLogin', () => {
  it.each([
    [BASE, false],
    [{ ...BASE, prompt: 'consent' }, false],
    [{ ...BASE, prompt: 'login' }, true],
    [REAUTH, true],
    [{ ...BASE, reauth_intent: 'disable' as const, expected_account: ME }, true],
  ])('%j → %s', (req, expected) => {
    expect(requiresFreshLogin(req as AuthRequestPayload)).toBe(expected);
  });
});
