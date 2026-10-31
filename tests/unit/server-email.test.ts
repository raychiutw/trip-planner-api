/**
 * src/server/email.ts unit tests (post-mac-mini-cutover)
 * 驗證 fetch 對 mac mini tunnel + Bearer + body shape + error handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, EmailError } from '../../src/lib/email';

describe('sendEmail (mac mini tunnel)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchResolve(response: { ok: boolean; status: number; body: unknown }) {
    return vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
    });
  }

  const validEnv = {
    TRIPLINE_API_URL: 'https://mac-mini.tail.ts.net:8443',
    TRIPLINE_API_SECRET: 'test-bearer-secret',
  };

  const validParams = {
    to: 'user@example.com',
    subject: '驗證信',
    html: '<p>請點擊連結驗證</p>',
  };

  it('throws EmailError when TRIPLINE_API_URL missing', async () => {
    await expect(
      sendEmail({ TRIPLINE_API_SECRET: 'x' }, validParams),
    ).rejects.toThrow(EmailError);
    await expect(
      sendEmail({ TRIPLINE_API_SECRET: 'x' }, validParams),
    ).rejects.toThrow(/TRIPLINE_API_URL/);
  });

  it('throws EmailError when TRIPLINE_API_SECRET missing', async () => {
    await expect(
      sendEmail({ TRIPLINE_API_URL: 'x' }, validParams),
    ).rejects.toThrow(/TRIPLINE_API_SECRET/);
  });

  it('posts to /internal/mail/send with Bearer auth + correct body', async () => {
    const fetchMock = mockFetchResolve({
      ok: true,
      status: 200,
      body: { ok: true, messageId: 'msg-x', elapsed: 1234 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = fetchMock as any;

    await sendEmail(validEnv, validParams);

    expect(fetchMock).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://mac-mini.tail.ts.net:8443/internal/mail/send');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-bearer-secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      to: 'user@example.com',
      subject: '驗證信',
      html: '<p>請點擊連結驗證</p>',
    });
  });

  it('forwards text fallback when provided', async () => {
    const fetchMock = mockFetchResolve({
      ok: true,
      status: 200,
      body: { ok: true, messageId: 'msg-y' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = fetchMock as any;

    await sendEmail(validEnv, { ...validParams, text: 'plain text fallback' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).text).toBe('plain text fallback');
  });

  it('forwards template hint when provided', async () => {
    const fetchMock = mockFetchResolve({
      ok: true,
      status: 200,
      body: { ok: true, messageId: 'msg-z' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = fetchMock as any;

    await sendEmail(validEnv, { ...validParams, template: 'verification' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).template).toBe('verification');
  });

  it('returns ok + id + elapsed on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = mockFetchResolve({
      ok: true,
      status: 200,
      body: { ok: true, messageId: 'msg-w', elapsed: 999 },
    }) as any;

    const result = await sendEmail(validEnv, validParams);
    expect(result).toEqual({ ok: true, id: 'msg-w', elapsed: 999 });
  });

  it('throws EmailError on non-2xx with status + parsed error msg', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = mockFetchResolve({
      ok: false,
      status: 500,
      body: { error: 'SMTP unreachable' },
    }) as any;

    try {
      await sendEmail(validEnv, validParams);
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EmailError);
      const e = err as EmailError;
      expect(e.status).toBe(500);
      expect(e.message).toContain('SMTP unreachable');
    }
  });

  it('throws EmailError when fetch rejects (network down)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network fail')) as any;

    await expect(sendEmail(validEnv, validParams)).rejects.toThrow(
      /Mailer fetch failed.*network fail/,
    );
  });

  it('throws EmailError when response missing messageId', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = mockFetchResolve({
      ok: true,
      status: 200,
      body: { ok: true /* no messageId */ },
    }) as any;

    await expect(sendEmail(validEnv, validParams)).rejects.toThrow(/missing messageId/);
  });

  it('returns elapsed=0 when response omits elapsed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = mockFetchResolve({
      ok: true,
      status: 200,
      body: { ok: true, messageId: 'msg-x' },
    }) as any;

    const result = await sendEmail(validEnv, validParams);
    expect(result.elapsed).toBe(0);
  });

  it('handles non-json error response gracefully', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    }) as any;

    await expect(sendEmail(validEnv, validParams)).rejects.toThrow(/Mailer responded 502/);
  });
});
