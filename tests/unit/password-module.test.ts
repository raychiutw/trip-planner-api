/**
 * src/server/password.ts unit test — V2-P2
 *
 * PBKDF2-SHA256 password hashing — sign+verify roundtrip + edge cases。
 */
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash } from '../../src/lib/password';

describe('hashPassword', () => {
  it('returns format pbkdf2$iter$salt$hash', async () => {
    const stored = await hashPassword('correct-horse-battery-staple');
    expect(stored).toMatch(/^pbkdf2\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  });

  it('iterations field ≥ 100,000 (CF Workers Free CPU budget compromise; bump to 600k on Paid plan)', async () => {
    const stored = await hashPassword('password123');
    const iter = Number(stored.split('$')[1]);
    expect(iter).toBeGreaterThanOrEqual(100_000);
  });

  it('different calls produce different output (random salt)', async () => {
    const h1 = await hashPassword('same-password');
    const h2 = await hashPassword('same-password');
    expect(h1).not.toBe(h2);
    // 但 verify 兩個都通
    expect(await verifyPassword('same-password', h1)).toBe(true);
    expect(await verifyPassword('same-password', h2)).toBe(true);
  });

  it('rejects password < 8 chars (sanity)', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/8 chars/);
    await expect(hashPassword('')).rejects.toThrow();
  });
}, 30_000); // 600k iterations 慢，給 30s timeout

describe('verifyPassword', () => {
  it('correct password → true', async () => {
    const stored = await hashPassword('p@ssw0rd-test');
    expect(await verifyPassword('p@ssw0rd-test', stored)).toBe(true);
  });

  it('wrong password → false', async () => {
    const stored = await hashPassword('correct1');
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('empty plaintext → false', async () => {
    const stored = await hashPassword('p@ssw0rd');
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('malformed stored hash → false (no throw)', async () => {
    expect(await verifyPassword('any', 'not-pbkdf2-format')).toBe(false);
    expect(await verifyPassword('any', 'pbkdf2$$$')).toBe(false);
    expect(await verifyPassword('any', 'pbkdf2$abc$salt$hash')).toBe(false); // iter not number
  });

  it('different algorithm prefix → false (future-proof)', async () => {
    expect(await verifyPassword('any', 'argon2id$1$salt$hash')).toBe(false);
  });

  it('case-sensitive password compare', async () => {
    const stored = await hashPassword('CaseSensitive');
    expect(await verifyPassword('CaseSensitive', stored)).toBe(true);
    expect(await verifyPassword('casesensitive', stored)).toBe(false);
  });
}, 60_000);

describe('needsRehash', () => {
  it('returns false for current-iteration hash', async () => {
    const stored = await hashPassword('test1234');
    expect(needsRehash(stored)).toBe(false);
  });

  it('returns true for hash with lower iter count (legacy)', () => {
    // Current ITERATIONS = 100_000 (CF Workers CPU budget). 50_000 is below.
    expect(needsRehash('pbkdf2$50000$salt$hash')).toBe(true);
  });

  it('returns true for non-pbkdf2 algorithm (legacy md5/sha1)', () => {
    expect(needsRehash('md5$salt$hash')).toBe(true);
    expect(needsRehash('plaintext-not-formatted')).toBe(true);
  });
}, 30_000);
