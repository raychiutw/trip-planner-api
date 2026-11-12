/**
 * api → agent 呼叫改用簽章（issue #85，ADR-0011）。
 * 並存期：對應 purpose 的 AGENT_SIGNING_KEY_* 有設 → 只帶簽章 header、不帶 Bearer；沒設 → 維持 Bearer。
 * 期望值用 node:crypto 獨立重算（與被測實作的 WebCrypto 路徑不同源），另有與 agent 端共用的固定向量。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { agentAuthHeaders, SIGNING_HEADERS } from '../src/lib/signing';
import { sendEmail } from '../src/lib/email';

const TRIGGER_KEY = 'test-key-trigger-0000000000000000';
const MAIL_KEY = 'test-key-mail-000000000000000000';

// 與 agent 端、tests/signing.test.ts 共用的固定向量
const VECTOR = {
  url: 'https://agent.example.test/trigger?source=api',
  body: '{"hello":"world"}',
  signature: '7af5b15fb877370c805223a35dc4d3dbb838248f2c3b8c7ba3b0ed4af169e960',
};

function expectedSig(key: string, purpose: string, pathQuery: string, ts: string, nonce: string, body: string) {
  const canonical = [
    'TRIPLINE-HMAC-V1', purpose, 'POST', pathQuery, ts, nonce,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  return createHmac('sha256', key).update(canonical).digest('hex');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('agentAuthHeaders', () => {
  it('有 trigger 金鑰 → 簽章 header、無 Bearer；固定向量驗得過', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('nonce-fixed-0001' as `${string}-${string}-${string}-${string}-${string}`);
    const h = await agentAuthHeaders(
      { AGENT_SIGNING_KEY_TRIGGER: TRIGGER_KEY, TRIPLINE_API_SECRET: 'bearer-secret' },
      'trigger',
      { url: VECTOR.url, body: VECTOR.body },
    );
    expect(h[SIGNING_HEADERS.signature]).toBe(VECTOR.signature);
    expect(h[SIGNING_HEADERS.timestamp]).toBe('1800000000');
    expect(h[SIGNING_HEADERS.nonce]).toBe('nonce-fixed-0001');
    expect(h.Authorization).toBeUndefined();
  });

  it('沒金鑰 → 只有 Bearer，沒有簽章 header', async () => {
    const h = await agentAuthHeaders({ TRIPLINE_API_SECRET: 'bearer-secret' }, 'trigger', { url: VECTOR.url, body: '{}' });
    expect(h).toEqual({ Authorization: 'Bearer bearer-secret' });
  });

  it('purpose 對應各自的金鑰：只設 mail 金鑰時 trigger 仍走 Bearer', async () => {
    const env = { AGENT_SIGNING_KEY_MAIL: MAIL_KEY, TRIPLINE_API_SECRET: 'bearer-secret' };
    expect((await agentAuthHeaders(env, 'trigger', { url: VECTOR.url, body: '{}' })).Authorization).toBe('Bearer bearer-secret');
    expect((await agentAuthHeaders(env, 'mail', { url: VECTOR.url, body: '{}' })).Authorization).toBeUndefined();
  });

  it('簽章內含 body hash 與 path+query、purpose、秒級 timestamp', async () => {
    const url = 'https://agent.example.test/internal/mail/send';
    const h = await agentAuthHeaders({ AGENT_SIGNING_KEY_MAIL: MAIL_KEY }, 'mail', { url, body: '{"a":1}' });
    const ts = h[SIGNING_HEADERS.timestamp];
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    expect(h[SIGNING_HEADERS.signature]).toBe(
      expectedSig(MAIL_KEY, 'mail', '/internal/mail/send', ts!, h[SIGNING_HEADERS.nonce]!!, '{"a":1}'),
    );
  });
});

describe('sendEmail 走簽章', () => {
  const params = { to: 'u@example.com', subject: 's', html: '<p>x</p>' };
  const okFetch = () => vi.fn().mockResolvedValue({
    ok: true, status: 200, json: () => Promise.resolve({ messageId: 'm1', elapsed: 1 }),
  });

  it('有 mail 金鑰 → 簽章 header、無 Bearer，簽的是實際送出的 body；不需 TRIPLINE_API_SECRET', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await sendEmail({ TRIPLINE_API_URL: 'https://mini.tail.ts.net:8443', AGENT_SIGNING_KEY_MAIL: MAIL_KEY }, params);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBeUndefined();
    expect(h['Content-Type']).toBe('application/json');
    expect(h[SIGNING_HEADERS.signature]).toBe(
      expectedSig(MAIL_KEY, 'mail', '/internal/mail/send', h[SIGNING_HEADERS.timestamp]!, h[SIGNING_HEADERS.nonce]!, init.body as string),
    );
  });

  it('沒金鑰 → 與現在相同（Bearer）', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await sendEmail({ TRIPLINE_API_URL: 'https://mini.tail.ts.net:8443', TRIPLINE_API_SECRET: 'bs' }, params);
    const h = (f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer bs');
    expect(h[SIGNING_HEADERS.signature]).toBeUndefined();
  });

  it('URL 不在 allowlist → 即使有金鑰也不外呼', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await expect(
      sendEmail({ TRIPLINE_API_URL: 'https://evil.example.com', AGENT_SIGNING_KEY_MAIL: MAIL_KEY }, params),
    ).rejects.toThrow(/invalid/);
    expect(f).not.toHaveBeenCalled();
  });
});
