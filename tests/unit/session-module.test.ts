// @ts-nocheck — 逐字搬自舊 repo（其 tsconfig 較寬鬆）；型別嚴格度差異不影響執行語意。
/**
 * src/server/session.ts unit test — V2-P1
 *
 * Sign/verify roundtrip + tamper detection + expiry + format validation。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  signSessionToken,
  verifySessionToken,
  generateCsrfToken,
} from '../../src/lib/session';

const SECRET = 'test-session-secret-not-real-prod';

describe('session module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'));
  });

  // v2.33.65 round 15: restore real timers to prevent cross-file leak inside same worker
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generateCsrfToken', () => {
    it('returns base64url string ~43 chars (32 bytes)', () => {
      const token = generateCsrfToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url (no +/=)
      expect(token.length).toBeGreaterThanOrEqual(40);
      expect(token.length).toBeLessThanOrEqual(44);
    });

    it('generates unique tokens (random)', () => {
      const tokens = new Set();
      for (let i = 0; i < 50; i++) tokens.add(generateCsrfToken());
      expect(tokens.size).toBe(50);
    });
  });

  describe('signSessionToken / verifySessionToken roundtrip', () => {
    it('sign + verify same secret → returns parsed payload with uid + iat + exp + csrf + v', async () => {
      const token = await signSessionToken('user-uuid-123', SECRET);
      const payload = await verifySessionToken(token, SECRET);
      expect(payload).not.toBeNull();
      expect(payload?.uid).toBe('user-uuid-123');
      expect(payload?.v).toBe(1);
      expect(typeof payload?.iat).toBe('number');
      expect(typeof payload?.exp).toBe('number');
      expect(typeof payload?.csrf).toBe('string');
      expect(payload!.exp - payload!.iat).toBe(30 * 24 * 60 * 60); // default 30d
    });

    it('custom TTL respected', async () => {
      const token = await signSessionToken('uid-1', SECRET, 600); // 10 min
      const payload = await verifySessionToken(token, SECRET);
      expect(payload?.exp).toBe(payload!.iat + 600);
    });

    it('verify with different secret → null (HMAC mismatch)', async () => {
      const token = await signSessionToken('uid-1', SECRET);
      expect(await verifySessionToken(token, 'wrong-secret')).toBeNull();
    });

    it('verify expired token → null', async () => {
      const token = await signSessionToken('uid-1', SECRET, 60); // 1min TTL
      vi.advanceTimersByTime(61 * 1000); // jump 61s
      expect(await verifySessionToken(token, SECRET)).toBeNull();
    });

    it('format invalid (no dot) → null', async () => {
      expect(await verifySessionToken('not-a-valid-token', SECRET)).toBeNull();
    });

    it('format invalid (3 dots like JWT) → null', async () => {
      expect(await verifySessionToken('a.b.c', SECRET)).toBeNull();
    });

    it('payload tamper (modify base64url payload but keep HMAC) → null', async () => {
      const token = await signSessionToken('uid-1', SECRET);
      const [, sig] = token.split('.');
      // Replace payload with alternative valid base64url but different content
      const tampered = `eyJ2IjoxLCJ1aWQiOiJoYWNrZXIifQ.${sig}`;
      expect(await verifySessionToken(tampered, SECRET)).toBeNull();
    });

    it('payload version mismatch (v=999) → null (schema migration safety)', async () => {
      // Manually craft a payload with v=999 + valid HMAC for that payload
      const fakePayload = {
        v: 999, uid: 'u1', iat: 1, exp: 9999999999, csrf: 'x',
      };
      const json = JSON.stringify(fakePayload);
      const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      // We need to compute HMAC with same algorithm as production code
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64)));
      let sigStr = '';
      for (let i = 0; i < sigBytes.length; i++) sigStr += String.fromCharCode(sigBytes[i]);
      const sig = btoa(sigStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const token = `${b64}.${sig}`;
      expect(await verifySessionToken(token, SECRET)).toBeNull();
    });

    it('csrf token is unique per session (each sign creates new)', async () => {
      const t1 = await signSessionToken('uid-1', SECRET);
      const t2 = await signSessionToken('uid-1', SECRET);
      const p1 = await verifySessionToken(t1, SECRET);
      const p2 = await verifySessionToken(t2, SECRET);
      expect(p1?.csrf).not.toBe(p2?.csrf);
    });
  });
});
