/**
 * api → agent 簽章產生器測試（T17）。
 *
 * api 目前還沒有會呼叫 agent 的路由，所以這裡直接打 signing 模組的公開介面；
 * 兩個 repo 是否算出同一個簽章，靠下面的「固定測試向量」鎖住 ——
 * agent 端的 tests/unit/request-signing.test.ts 有一模一樣的向量。
 */
import { describe, it, expect } from 'vitest';
import { signAgentRequest, AGENT_SIGNING_PURPOSES, SIGNING_HEADERS } from '../src/lib/signing';

const KEY = 'test-key-trigger-0000000000000000';

// 與 agent 端測試共用的固定向量。改動 canonical string 格式會讓兩邊同時變紅。
const VECTOR = {
  purpose: 'trigger' as const,
  key: KEY,
  method: 'POST',
  url: 'https://agent.example.test/trigger?source=api',
  body: '{"hello":"world"}',
  timestamp: 1_800_000_000,
  nonce: 'nonce-fixed-0001',
  signature: '7af5b15fb877370c805223a35dc4d3dbb838248f2c3b8c7ba3b0ed4af169e960',
};

describe('signAgentRequest', () => {
  it('固定測試向量：同樣輸入永遠算出同一個簽章', async () => {
    const h = await signAgentRequest(VECTOR);
    expect(h[SIGNING_HEADERS.signature]).toBe(VECTOR.signature);
    expect(h[SIGNING_HEADERS.timestamp]).toBe('1800000000');
    expect(h[SIGNING_HEADERS.nonce]).toBe('nonce-fixed-0001');
  });

  it('用途只有 trigger / mail / mint 三種', () => {
    expect([...AGENT_SIGNING_PURPOSES].sort()).toEqual(['mail', 'mint', 'trigger']);
  });

  it('沒給 timestamp / nonce 時自動產生，且每次 nonce 都不同', async () => {
    const a = await signAgentRequest({ ...VECTOR, timestamp: undefined, nonce: undefined });
    const b = await signAgentRequest({ ...VECTOR, timestamp: undefined, nonce: undefined });
    expect(a[SIGNING_HEADERS.nonce]).not.toBe(b[SIGNING_HEADERS.nonce]);
    expect(Math.abs(Number(a[SIGNING_HEADERS.timestamp]) - Date.now() / 1000)).toBeLessThan(5);
  });

  it.each([
    ['method', { method: 'GET' }],
    ['path', { url: 'https://agent.example.test/internal/mail/send?source=api' }],
    ['query', { url: 'https://agent.example.test/trigger?source=job' }],
    ['body', { body: '{"hello":"WORLD"}' }],
    ['timestamp', { timestamp: 1_800_000_001 }],
    ['nonce', { nonce: 'nonce-fixed-0002' }],
    ['purpose', { purpose: 'mail' as const }],
    ['key', { key: 'another-key-another-key-000000' }],
  ])('%s 不同 → 簽章不同', async (_n, patch) => {
    const base = await signAgentRequest(VECTOR);
    const changed = await signAgentRequest({ ...VECTOR, ...patch });
    expect(changed[SIGNING_HEADERS.signature]).not.toBe(base[SIGNING_HEADERS.signature]);
  });

  it('host 不同、path 相同 → 簽章相同（只簽 path + query，不簽 host）', async () => {
    const a = await signAgentRequest(VECTOR);
    const b = await signAgentRequest({ ...VECTOR, url: 'https://other-host.test/trigger?source=api' });
    expect(b[SIGNING_HEADERS.signature]).toBe(a[SIGNING_HEADERS.signature]);
  });

  it('key 太短或空 → 拒絕簽（fail-closed）', async () => {
    await expect(signAgentRequest({ ...VECTOR, key: '' })).rejects.toThrow();
    await expect(signAgentRequest({ ...VECTOR, key: 'short' })).rejects.toThrow();
  });

  it('未知用途 → 拒絕簽', async () => {
    await expect(signAgentRequest({ ...VECTOR, purpose: 'admin' as never })).rejects.toThrow();
  });

  it('回傳的 header 不含 key 本身', async () => {
    const h = await signAgentRequest(VECTOR);
    expect(JSON.stringify(h)).not.toContain(KEY);
  });
});
