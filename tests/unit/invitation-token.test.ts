/**
 * invitation-token.test.ts — V2 共編邀請 token contract
 * v2.33.58 round 12b: CRITICAL ZERO_COVERAGE fill — HMAC parity 只在 endpoint
 * test 內被 side-assert，本檔直接驗 generate / hash / TTL helper。
 */
import { describe, it, expect } from 'vitest';
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  INVITATION_TTL_DAYS,
} from '../../src/lib/invitation-token';

const SECRET = 'test-secret-32-bytes-long-enough';

describe('generateInvitationToken', () => {
  it('returns rawToken (32-byte base64url) + tokenHash (HMAC of raw)', async () => {
    const { rawToken, tokenHash } = await generateInvitationToken(SECRET);
    // 32 bytes raw → ~43 chars base64url (no padding)
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{42,44}$/);
    expect(tokenHash).toMatch(/^[A-Za-z0-9_-]{42,44}$/);
    // hashInvitationToken(rawToken, secret) reproduces tokenHash
    expect(await hashInvitationToken(rawToken, SECRET)).toBe(tokenHash);
  });

  it('rawToken 跨 50 次 call 全唯一 (sufficient entropy)', async () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { rawToken } = await generateInvitationToken(SECRET);
      set.add(rawToken);
    }
    expect(set.size).toBe(50);
  });
});

describe('hashInvitationToken', () => {
  it('deterministic for same (token, secret) pair', async () => {
    const a = await hashInvitationToken('my-token', SECRET);
    const b = await hashInvitationToken('my-token', SECRET);
    expect(a).toBe(b);
  });

  it('different secret produces different hash (rotation-safe)', async () => {
    const a = await hashInvitationToken('my-token', SECRET);
    const b = await hashInvitationToken('my-token', 'different-secret');
    expect(a).not.toBe(b);
  });

  it('different token produces different hash (collision-resistant)', async () => {
    const a = await hashInvitationToken('token-a', SECRET);
    const b = await hashInvitationToken('token-b', SECRET);
    expect(a).not.toBe(b);
  });

  it('hash 是 base64url (HMAC-SHA256 → 32 bytes → 43 chars no padding)', async () => {
    const hash = await hashInvitationToken('any-token', SECRET);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain('=');
    expect(hash.length).toBe(43);
  });
});

describe('invitationExpiresAt', () => {
  it('default 7 days from now ISO 8601', () => {
    const iso = invitationExpiresAt();
    const dt = new Date(iso);
    const expected = Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
    // Within 2 second tolerance
    expect(Math.abs(dt.getTime() - expected)).toBeLessThan(2000);
  });

  it('custom days arg', () => {
    const iso = invitationExpiresAt(30);
    const dt = new Date(iso);
    const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(dt.getTime() - expected)).toBeLessThan(2000);
  });

  it('INVITATION_TTL_DAYS 常數 = 7', () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
  });
});
