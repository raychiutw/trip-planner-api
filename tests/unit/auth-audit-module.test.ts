// @ts-nocheck — 逐字搬自舊 repo（其 tsconfig 較寬鬆）；型別嚴格度差異不影響執行語意。
/**
 * functions/api/_auth_audit.ts unit test — V2-P6
 */
import { describe, it, expect, vi } from 'vitest';
import { recordAuthEvent } from '../../src/lib/auth-audit';
import type { D1Database } from '@cloudflare/workers-types';

interface MockStmt {
  bind: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function makeMockDb(runError?: Error) {
  const stmt: MockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockImplementation(() => runError ? Promise.reject(runError) : Promise.resolve({ meta: { changes: 1 } })),
  };
  const db = {
    prepare: vi.fn().mockReturnValue(stmt),
  } as unknown as D1Database;
  return { db, stmt, prepare: db.prepare as ReturnType<typeof vi.fn> };
}

function makeRequest(opts: { ip?: string; ua?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip;
  if (opts.ua) headers['User-Agent'] = opts.ua;
  return new Request('https://x.com/auth', { method: 'POST', headers });
}

describe('recordAuthEvent', () => {
  it('inserts row with all expected columns', async () => {
    const { db, stmt, prepare } = makeMockDb();
    await recordAuthEvent(db, makeRequest({ ip: '1.2.3.4', ua: 'TestAgent/1.0' }), {
      eventType: 'login',
      outcome: 'success',
      userId: 'u1',
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect((prepare.mock.calls[0][0] as string)).toMatch(/INSERT INTO auth_audit_log/);
    expect(stmt.bind).toHaveBeenCalledTimes(1);
    expect(stmt.run).toHaveBeenCalledTimes(1);

    const args = stmt.bind.mock.calls[0];
    expect(args[0]).toBeNull();           // trace_id
    expect(args[1]).toBe('login');        // event_type
    expect(args[2]).toBe('success');      // outcome
    expect(args[3]).toBe('u1');           // user_id
    expect(args[4]).toBeNull();           // client_id
    expect(typeof args[5]).toBe('string'); // ip_hash (base64 of SHA-256)
    expect(args[5]).not.toBe('1.2.3.4');  // never raw IP
    expect(args[6]).toBe('TestAgent/1.0'); // user_agent
    expect(args[7]).toBeNull();           // failure_reason
    expect(args[8]).toBeNull();           // metadata
  });

  it('truncates user_agent at 200 chars', async () => {
    const { db, stmt } = makeMockDb();
    const longUa = 'A'.repeat(500);
    await recordAuthEvent(db, makeRequest({ ip: '1.1.1.1', ua: longUa }), {
      eventType: 'login',
      outcome: 'success',
    });
    const ua = stmt.bind.mock.calls[0][6] as string;
    expect(ua.length).toBe(200);
  });

  it('serialises metadata as JSON string', async () => {
    const { db, stmt } = makeMockDb();
    await recordAuthEvent(db, makeRequest({ ip: '1.1.1.1' }), {
      eventType: 'oauth_authorize',
      outcome: 'failure',
      clientId: 'app-1',
      failureReason: 'invalid_redirect',
      metadata: { redirect_uri: 'https://attacker.com', scope: 'openid' },
    });
    const args = stmt.bind.mock.calls[0];
    expect(args[4]).toBe('app-1');
    expect(args[7]).toBe('invalid_redirect');
    const meta = JSON.parse(args[8] as string);
    expect(meta).toEqual({ redirect_uri: 'https://attacker.com', scope: 'openid' });
  });

  it('falls back to ip="unknown" when CF-Connecting-IP missing', async () => {
    const { db, stmt } = makeMockDb();
    await recordAuthEvent(db, makeRequest(), {
      eventType: 'login',
      outcome: 'success',
    });
    const ipHash = stmt.bind.mock.calls[0][5] as string;
    expect(typeof ipHash).toBe('string');
    expect(ipHash.length).toBeGreaterThan(0);
  });

  it('user_agent NULL when header absent', async () => {
    const { db, stmt } = makeMockDb();
    await recordAuthEvent(db, makeRequest({ ip: '1.1.1.1' }), {
      eventType: 'logout',
      outcome: 'success',
      userId: 'u',
    });
    expect(stmt.bind.mock.calls[0][6]).toBeNull();
  });

  it('does NOT throw when DB insert fails (best-effort)', async () => {
    const { db } = makeMockDb(new Error('D1 unavailable'));
    await expect(
      recordAuthEvent(db, makeRequest({ ip: '1.1.1.1' }), {
        eventType: 'login',
        outcome: 'failure',
      }),
    ).resolves.toBeUndefined();
  });

  it('IP hash deterministic: same ip → same hash', async () => {
    const { db, stmt } = makeMockDb();
    await recordAuthEvent(db, makeRequest({ ip: '203.0.113.5' }), {
      eventType: 'login', outcome: 'success',
    });
    await recordAuthEvent(db, makeRequest({ ip: '203.0.113.5' }), {
      eventType: 'logout', outcome: 'success',
    });
    expect(stmt.bind.mock.calls[0][5]).toBe(stmt.bind.mock.calls[1][5]);
  });

  it('IP hash differs for different IPs', async () => {
    const { db, stmt } = makeMockDb();
    await recordAuthEvent(db, makeRequest({ ip: '1.1.1.1' }), {
      eventType: 'login', outcome: 'success',
    });
    await recordAuthEvent(db, makeRequest({ ip: '2.2.2.2' }), {
      eventType: 'login', outcome: 'success',
    });
    expect(stmt.bind.mock.calls[0][5]).not.toBe(stmt.bind.mock.calls[1][5]);
  });

  it('passes traceId when provided (OAuth flow correlation)', async () => {
    const { db, stmt } = makeMockDb();
    await recordAuthEvent(db, makeRequest({ ip: '1.1.1.1' }), {
      eventType: 'oauth_consent',
      outcome: 'success',
      userId: 'u',
      clientId: 'c',
      traceId: 'trace-abc-123',
    });
    expect(stmt.bind.mock.calls[0][0]).toBe('trace-abc-123');
  });
});
