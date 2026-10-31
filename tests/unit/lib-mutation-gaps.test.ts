// @ts-nocheck — 與其他搬來的測試一致（舊 repo 型別較寬鬆）。
/**
 * 搬移後 mutation 驗證發現「原測試抓不到」的分支，於此補測（拆分 T9 共用函式庫）。
 * 每個測試都對應一個存活過的 mutant：
 *   jwt 簽章驗證 / exp 邊界、password constant-time 長度檢查、invitation HKDF domain separation、
 *   audit 亂碼警示、maskEmail 無網域點、email Subject header 清洗。
 */
import { describe, it, expect, vi } from 'vitest';
import { signJwt, verifyJwt } from '../../src/lib/jwt';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { hashInvitationToken } from '../../src/lib/invitation-token';
import { deriveSubSecret } from '../../src/lib/hkdf';
import { logAudit } from '../../src/lib/audit';
import { maskEmail } from '../../src/lib/pii';
import { tripInvitation } from '../../src/lib/email-templates';

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function keyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

describe('jwt 缺口', () => {
  it('payload 被竄改但簽章沿用舊的 → 必須拒絕（簽章驗證不可省）', async () => {
    const { privateKey, publicKey } = await keyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({ iss: 'i', sub: 'u1', aud: 'a', iat: now, exp: now + 600 }, privateKey, 'k1');
    const [h, , s] = token.split('.');
    const forged = b64u(JSON.stringify({ iss: 'i', sub: 'admin', aud: 'a', iat: now, exp: now + 600 }));
    await expect(verifyJwt(`${h}.${forged}.${s}`, publicKey)).rejects.toThrow('JWT signature invalid');
  });

  it('exp 邊界：now === exp 即過期（嚴格，不給寬限）', async () => {
    const { privateKey, publicKey } = await keyPair();
    const token = await signJwt({ iss: 'i', sub: 'u', aud: 'a', iat: 1000, exp: 2000 }, privateKey, 'k1');
    await expect(verifyJwt(token, publicKey, { now: 2000 })).rejects.toThrow('JWT expired');
    await expect(verifyJwt(token, publicKey, { now: 1999 })).resolves.toBeTruthy();
  });
});

describe('password 缺口', () => {
  it('stored hash 比計算值多一個 byte（前綴相同）→ 不可通過', async () => {
    const stored = await hashPassword('correct-horse-battery');
    const parts = stored.split('$');
    const b64 = parts[3].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '=='.slice(0, (4 - (b64.length % 4)) % 4));
    parts[3] = b64u(bin + '\x00');
    expect(await verifyPassword('correct-horse-battery', parts.join('$'))).toBe(false);
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true);
  });
});

describe('invitation token 缺口', () => {
  it('HMAC 金鑰用 invitation_token_v1 衍生，與 session_v1 隔離（domain separation）', async () => {
    const secret = 'master-secret';
    const raw = 'raw-token';
    const hash = await hashInvitationToken(raw, secret);
    const sessionKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(await deriveSubSecret(secret, 'session_v1')),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', sessionKey, new TextEncoder().encode(raw)));
    let str = '';
    for (const b of sig) str += String.fromCharCode(b);
    expect(hash).not.toBe(b64u(str));
  });
});

describe('audit / pii / email 缺口', () => {
  it('logAudit：diffJson 含亂碼 → 寫入時帶 _encoding_warning', async () => {
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) };
    await logAudit(db, {
      tripId: 't', tableName: 'trips', recordId: 1, action: 'update', changedBy: 'u',
      diffJson: JSON.stringify({ name: 'bad�text' }),
    });
    const written = bind.mock.calls[0][6] as string;
    expect(JSON.parse(written)._encoding_warning).toBe(true);
  });

  it('logAudit：正常 diffJson 不加警示', async () => {
    const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) });
    const db = { prepare: vi.fn().mockReturnValue({ bind }) };
    await logAudit(db, {
      tripId: 't', tableName: 'trips', recordId: 1, action: 'update', changedBy: 'u',
      diffJson: JSON.stringify({ name: '正常' }),
    });
    expect(JSON.parse(bind.mock.calls[0][6])._encoding_warning).toBeUndefined();
  });

  it('maskEmail：網域沒有點 → 回佔位', () => {
    expect(maskEmail('ray@localhost')).toBe('***');
  });

  it('tripInvitation：Subject 內的 CR/LF 不得殘留（header injection）', () => {
    const t = tripInvitation({
      inviterEmail: 'a@b.com',
      inviterDisplayName: null,
      tripTitle: '行程\r\nBcc: evil@x.com',
      inviteUrl: 'https://x/y',
      isExistingUser: true,
    });
    expect(t.subject).not.toMatch(/[\r\n]/);
  });
});
