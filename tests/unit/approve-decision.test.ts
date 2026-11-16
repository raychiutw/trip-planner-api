/**
 * 批准決策純函式（不經資料庫）：授權請求 + 批准者 → 判別式結果。
 * 表格涵蓋：一般批准、帶意圖、意圖綁定設定者、舊的重新驗證欄位被忽略、deny。
 */
import { describe, it, expect } from 'vitest';
import { decideApproval } from '../../src/lib/oauth-server/approve-decision';
import type { AuthRequestPayload } from '../../src/lib/auth-request';

const BASE: AuthRequestPayload = {
  client_id: 'c', redirect_uri: 'https://x.com/cb', scopes: ['openid'], state: 's',
  code_challenge: 'ch', code_challenge_method: 'S256', prompt: null,
};
const ME = 'user-me';
const OTHER = 'user-other';
/** 部署前建立、仍在 TTL 內的舊重新驗證請求：欄位還在 payload 裡，但一律忽略。 */
const LEGACY_REAUTH: AuthRequestPayload = { ...BASE, prompt: 'login', reauth_intent: 'disable', expected_account: ME };

type Case = { name: string; decision: 'approve' | 'deny'; req: AuthRequestPayload; userId: string; expected: unknown };
const cases: Case[] = [
  { name: '一般批准：沒有旗標', decision: 'approve', req: BASE, userId: ME, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '帶意圖：設定者就是批准者 → 旗標', decision: 'approve', req: { ...BASE, intent: 'enable', intent_user_id: ME }, userId: ME, expected: { kind: 'approve', biometricIntent: 'enable' } },
  { name: '帶意圖：別人批准 → 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'enable', intent_user_id: ME }, userId: OTHER, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '帶意圖：沒有設定者 → 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'enable' }, userId: ME, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '意圖不在白名單（含已移除的 disable）→ 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'disable' as never, intent_user_id: ME }, userId: ME, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '意圖是注入字串 → 不帶旗標', decision: 'approve', req: { ...BASE, intent: 'https://evil.test&x=1' as never, intent_user_id: ME }, userId: ME, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '單獨 prompt=login：照一般批准', decision: 'approve', req: { ...BASE, prompt: 'login' }, userId: OTHER, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '舊重新驗證欄位：別的帳號照一般批准、不帶旗標', decision: 'approve', req: LEGACY_REAUTH, userId: OTHER, expected: { kind: 'approve', biometricIntent: undefined } },
  { name: '舊重新驗證欄位：不會蓋過 web 記下的 enable', decision: 'approve', req: { ...LEGACY_REAUTH, intent: 'enable', intent_user_id: OTHER }, userId: OTHER, expected: { kind: 'approve', biometricIntent: 'enable' } },
  { name: 'deny：一般', decision: 'deny', req: BASE, userId: ME, expected: { kind: 'deny' } },
  { name: 'deny：帶意圖也不帶旗標', decision: 'deny', req: { ...BASE, intent: 'enable', intent_user_id: ME }, userId: ME, expected: { kind: 'deny' } },
];

describe('decideApproval（純函式表格）', () => {
  it.each(cases)('$name', ({ decision, req, userId, expected }) => {
    expect(decideApproval({ decision, req, userId })).toEqual(expected);
  });
});
