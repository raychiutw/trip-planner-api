/**
 * validateEntryBody lat/lng range check — v2.31.94 custom-stop-location-picker
 *
 * 當 entry POST body 帶 lat/lng（custom stop with map pin），backend 第二道
 * validate：XOR 拒絕（只一個值無法用）、NaN 拒、out-of-range 拒、valid pass。
 *
 * 既有純 name 路徑（search tab / favorite tab 無 lat/lng）不受影響。
 */
import { describe, it, expect } from 'vitest';
import { validateEntryBody } from '../../src/lib/validate';

describe('validateEntryBody — lat/lng range check (v2.31.94)', () => {
  it('valid lat/lng pair passes', () => {
    const result = validateEntryBody({
      name: '外婆家',
      lat: 22.6724,
      lng: 120.2932,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('boundary values (lat ±90, lng ±180) pass', () => {
    expect(validateEntryBody({ name: 'a', lat: 90, lng: 180 }).ok).toBe(true);
    expect(validateEntryBody({ name: 'a', lat: -90, lng: -180 }).ok).toBe(true);
    expect(validateEntryBody({ name: 'a', lat: 0, lng: 0 }).ok).toBe(true);
  });

  it('no lat/lng (search/favorite tab path) passes', () => {
    const result = validateEntryBody({ name: '美麗海水族館' });
    expect(result.ok).toBe(true);
  });

  it('XOR: only lat present → fails with clear message', () => {
    const result = validateEntryBody({ name: 'a', lat: 22.6 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain('座標');
  });

  it('XOR: only lng present → fails', () => {
    const result = validateEntryBody({ name: 'a', lng: 120.0 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain('座標');
  });

  it('lat NaN → fails', () => {
    const result = validateEntryBody({ name: 'a', lat: NaN, lng: 120 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('座標');
  });

  it('lng Infinity → fails', () => {
    const result = validateEntryBody({ name: 'a', lat: 22, lng: Infinity });
    expect(result.ok).toBe(false);
  });

  it('lat out of range (>90) → fails', () => {
    const result = validateEntryBody({ name: 'a', lat: 91, lng: 120 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('座標');
  });

  it('lat out of range (<-90) → fails', () => {
    const result = validateEntryBody({ name: 'a', lat: -90.1, lng: 120 });
    expect(result.ok).toBe(false);
  });

  it('lng out of range (>180) → fails', () => {
    const result = validateEntryBody({ name: 'a', lat: 22, lng: 180.5 });
    expect(result.ok).toBe(false);
  });

  it('lng out of range (<-180) → fails', () => {
    const result = validateEntryBody({ name: 'a', lat: 22, lng: -181 });
    expect(result.ok).toBe(false);
  });

  // v2.31.94 — source allowlist (CSO finding #4)
  it('source not in allowlist → fails', () => {
    const result = validateEntryBody({ name: 'a', source: 'malicious' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('source');
  });
  it('source unbounded string → fails', () => {
    const result = validateEntryBody({ name: 'a', source: 'x'.repeat(10_000) });
    expect(result.ok).toBe(false);
  });
  it('source = "custom" passes', () => {
    expect(validateEntryBody({ name: 'a', source: 'custom' }).ok).toBe(true);
  });
  it('source = "google" / "ai" / "favorite" / "user-explore" all pass', () => {
    for (const s of ['ai', 'google', 'favorite', 'user-explore', 'manual', 'search']) {
      expect(validateEntryBody({ name: 'a', source: s }).ok).toBe(true);
    }
  });
  it('source absent / null still passes (backward-compat)', () => {
    expect(validateEntryBody({ name: 'a' }).ok).toBe(true);
    expect(validateEntryBody({ name: 'a', source: null }).ok).toBe(true);
  });

  it('lat/lng as string ("22.6") → fails (must be number)', () => {
    const result = validateEntryBody({
      name: 'a',
      lat: '22.6' as unknown as number,
      lng: 120,
    });
    expect(result.ok).toBe(false);
  });

  it('name missing still has priority (matches existing contract)', () => {
    const result = validateEntryBody({ lat: 22, lng: 120 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('name');
  });

  it('lat=null / lng=null treated as not-present (no XOR fail)', () => {
    const result = validateEntryBody({
      name: 'a',
      lat: null as unknown as number,
      lng: null as unknown as number,
    });
    expect(result.ok).toBe(true);
  });
});
