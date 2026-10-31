/**
 * recordEmailEvent unit tests
 * 驗證 audit_log 寫入欄位 + diff_json 結構
 */
import { describe, it, expect, vi } from 'vitest';
import { recordEmailEvent } from '../../src/lib/audit';

interface CapturedInsert {
  sql: string;
  bindings: unknown[];
}

function makeFakeDb() {
  const captured: CapturedInsert = { sql: '', bindings: [] };
  const fakeDb = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        captured.sql = sql;
        captured.bindings = args;
        return {
          run: vi.fn().mockResolvedValue({ success: true }),
        };
      }),
    })),
  };
  return { db: fakeDb, captured };
}

describe('recordEmailEvent', () => {
  it('writes to audit_log with table_name=email + action=insert', async () => {
    const { db, captured } = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordEmailEvent(db as any, {
      template: 'verification',
      recipient: 'user@example.com',
      status: 'sent',
      latencyMs: 1234,
    });
    expect(captured.sql).toMatch(/INSERT INTO audit_log/);
    expect(captured.bindings[0]).toBe('system'); // trip_id default
    expect(captured.bindings[1]).toBe('email'); // table_name
    expect(captured.bindings[3]).toBe('insert'); // action
    expect(captured.bindings[4]).toBe('system'); // changed_by default
    const diff = JSON.parse(captured.bindings[6] as string);
    expect(diff).toEqual({
      template: 'verification',
      recipient: 'user@example.com',
      status: 'sent',
      error: null,
      latency_ms: 1234,
    });
  });

  it('uses tripId when provided (invitation context)', async () => {
    const { db, captured } = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordEmailEvent(db as any, {
      template: 'invitation',
      recipient: 'friend@example.com',
      status: 'sent',
      tripId: 'okinawa-trip-2026',
      triggeredBy: 'lean.lean@gmail.com',
    });
    expect(captured.bindings[0]).toBe('okinawa-trip-2026');
    expect(captured.bindings[4]).toBe('lean.lean@gmail.com');
  });

  it('captures error message + failed status in diff_json', async () => {
    const { db, captured } = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordEmailEvent(db as any, {
      template: 'forgot-password',
      recipient: 'a@b.c',
      status: 'failed',
      error: 'SMTP unreachable',
    });
    const diff = JSON.parse(captured.bindings[6] as string);
    expect(diff.status).toBe('failed');
    expect(diff.error).toBe('SMTP unreachable');
    expect(diff.latency_ms).toBeNull();
  });

  it('handles config-missing status', async () => {
    const { db, captured } = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordEmailEvent(db as any, {
      template: 'verification',
      recipient: 'a@b.c',
      status: 'config-missing',
      error: 'TRIPLINE_API_URL not set',
    });
    const diff = JSON.parse(captured.bindings[6] as string);
    expect(diff.status).toBe('config-missing');
  });

  it('handles trigger-failed status with tripId', async () => {
    const { db, captured } = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordEmailEvent(db as any, {
      template: 'trigger',
      recipient: 'system',
      status: 'trigger-failed',
      tripId: 'sample-trip',
      error: 'Trigger responded 502',
    });
    expect(captured.bindings[0]).toBe('sample-trip');
    const diff = JSON.parse(captured.bindings[6] as string);
    expect(diff.template).toBe('trigger');
    expect(diff.status).toBe('trigger-failed');
  });
});
